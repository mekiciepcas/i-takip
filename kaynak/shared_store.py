"""Windows/SMB append-only journal. No SQLite and no central application server.

Every reader/writer locks the SAME open data file over its whole range. File sharing
allows read/write but not delete/replace while open. An incomplete last frame is
recoverable; a complete frame with a bad checksum fails closed.
"""
import copy
import ctypes
from ctypes import wintypes
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import msvcrt
import os
from pathlib import Path
import struct
import threading
import time
import uuid

MAX_FRAME = 12 * 1024 * 1024
MAX_JOURNAL = 512 * 1024 * 1024
MAGIC = b'ISTAKIP5'
HEADER = struct.Struct('<8sQ')
kernel = ctypes.WinDLL('kernel32', use_last_error=True)

class Overlapped(ctypes.Structure):
    _fields_ = [('Internal', ctypes.c_size_t), ('InternalHigh', ctypes.c_size_t),
                ('Offset', wintypes.DWORD), ('OffsetHigh', wintypes.DWORD), ('hEvent', wintypes.HANDLE)]

kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
    ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
kernel.CreateFileW.restype = wintypes.HANDLE
kernel.LockFileEx.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
    wintypes.DWORD, wintypes.DWORD, ctypes.POINTER(Overlapped)]
kernel.LockFileEx.restype = wintypes.BOOL
kernel.UnlockFileEx.argtypes = [wintypes.HANDLE, wintypes.DWORD, wintypes.DWORD,
    wintypes.DWORD, ctypes.POINTER(Overlapped)]
kernel.UnlockFileEx.restype = wintypes.BOOL
kernel.CloseHandle.argtypes = [wintypes.HANDLE]
kernel.CloseHandle.restype = wintypes.BOOL
kernel.SetFileAttributesW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD]
kernel.SetFileAttributesW.restype = wintypes.BOOL
HIDDEN_SYSTEM = 0x2 | 0x4

class Conflict(Exception): pass
class Corruption(Exception): pass
class Busy(Exception): pass

def encode(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')

def protect_data_directory(path):
    """Hide the store from Explorer. This is not an ACL; the helper still opens files itself."""
    kernel.SetFileAttributesW(str(Path(path).resolve()), HIDDEN_SYSTEM)

def validate(data):
    if not isinstance(data, dict) or not isinstance(data.get('topics'), list) or not isinstance(data.get('sheets'), list):
        raise ValueError('topics ve sheets dizileri gerekli.')
    if len(data['topics']) > 10000 or not 1 <= len(data['sheets']) <= 200:
        raise ValueError('En fazla 10.000 konu ve 200 sayfa desteklenir.')
    sheets = data['sheets']
    if any(not isinstance(s, str) or not s.strip() or len(s)>31 or any(c in s for c in '\\/:*?[]') for s in sheets):
        raise ValueError('Sayfa adı geçersiz.')
    if len(set(sheets)) != len(sheets): raise ValueError('Tekrarlı sayfa.')
    ids = set()
    for row_number,t in enumerate(data['topics'],start=1):
        if not isinstance(t, dict) or not isinstance(t.get('id'), str) or not t['id'] or t['id'] in ids:
            raise ValueError('Konu kimliği eksik veya tekrarlı.')
        ids.add(t['id'])
        # Legacy Excel accepts long text; editor maxlength is not an import constraint.
        for field in ('topic','service','owner','topicType','current'):
            value=t.get(field,'')
            if not isinstance(value,str): raise ValueError(f'{field} alanı geçersiz.')
        if not t.get('topic','').strip(): raise ValueError(f'{row_number}. kayıtta konu başlığı boş.')
        if t.get('sheet') not in sheets: raise ValueError(f'{row_number}. kaydın sayfa adı çalışma sayfaları listesinde yok. Excel sayfa adı eşlemesini kontrol edin.')
        if t.get('status') not in ['Aktif','Askıda','Kapandı']: raise ValueError(f'{row_number}. kayıtta durum Aktif, Askıda veya Kapandı olmalı.')
        if t.get('priority','') not in ['','1','2','3','4','5']: raise ValueError(f'{row_number}. kayıtta önem boş veya 1–5 arasında olmalı.')
        date=t.get('closingDate','')
        if not isinstance(date,str): raise ValueError('Tarih geçersiz.')
        # V2 also accepts planning text (e.g. "TBD", "2027 ilk çeyrek").
        # Keep it verbatim; overdue indicators only use valid ISO dates.
        updates=t.get('updates',[])
        if not isinstance(updates,list): raise ValueError('Haftalık geçmiş geçersiz.')
        update_ids=set()
        for u in updates:
            if not isinstance(u,dict) or any(not isinstance(u.get(k),str) for k in ('id','date','note')) or not u['id'] or u['id'] in update_ids:
                raise ValueError('Haftalık not veya kimliği geçersiz.')
            update_ids.add(u['id'])
    normalized={'version':1,'sheets':sheets,'topics':data['topics']}
    if len(encode(normalized)) > 9*1024*1024: raise ValueError('Toplam veri 9 MB sınırını aşıyor.')
    return normalized

@contextmanager
def locked_file(path, timeout=10, create=False):
    # OPEN_ALWAYS is used ONLY during explicit initialization. Reads/writes must
    # not silently create a new database after disconnection or deletion.
    handle=kernel.CreateFileW(str(path),0x80000000|0x40000000,0x1|0x2,None,4 if create else 3,0x80000000,None)
    if handle == ctypes.c_void_p(-1).value: raise ctypes.WinError(ctypes.get_last_error())
    fd=msvcrt.open_osfhandle(handle,os.O_RDWR|os.O_BINARY)
    with os.fdopen(fd,'r+b',buffering=0) as stream:
        overlapped=Overlapped()
        end=time.monotonic()+timeout
        while not kernel.LockFileEx(handle,0x2|0x1,0,0xffffffff,0x7fffffff,ctypes.byref(overlapped)):
            error=ctypes.get_last_error()
            if error not in (33,158): raise ctypes.WinError(error)
            if time.monotonic()>=end: raise Busy('Ortak dosya meşgul; değişiklik korunuyor, tekrar deneyin.')
            time.sleep(0.03)
        try: yield stream
        finally:
            kernel.UnlockFileEx(handle,0,0xffffffff,0x7fffffff,ctypes.byref(overlapped))

def append_frame(stream, event):
    body=encode(event)
    if len(body)>MAX_FRAME: raise ValueError('İşlem çok büyük.')
    frame=HEADER.pack(MAGIC,len(body))+body+hashlib.sha256(body).digest()
    start=stream.tell()
    if start+len(frame)>MAX_JOURNAL: raise Busy('İşlem günlüğü 512 MB sınırına ulaştı. Arşivleme için tüm istemcileri kapatın; kayıt yapılmadı.')
    view=memoryview(frame)
    while view:
        count=stream.write(view)
        if not count: raise OSError('Dosyaya yazma tamamlanamadı.')
        view=view[count:]
    stream.flush();os.fsync(stream.fileno())
    stream.seek(start)
    if stream.read(len(frame)) != frame: raise OSError('Kayıt doğrulanamadı; işlem sonucu yeniden sorgulanmalı.')
    return stream.tell()

class Store:
    def __init__(self, directory):
        self.directory=Path(directory).resolve()
        self.path=self.directory/'is-takip.db'
        self.offset=0;self.revision=0;self.store_id=None;self.data=None;self.receipts={};self.mutex=threading.Lock()

    @property
    def etag(self): return f'"{self.store_id}:{self.revision}"'

    def initialize(self):
        self.directory.mkdir(parents=True,exist_ok=True)
        protect_data_directory(self.directory)
        identity=self.directory/'depo-kimligi.json'
        if identity.exists() and not self.path.exists():
            raise Corruption('Bu klasörün veri dosyası eksik. Boş veri oluşturulmadı; yedeği geri yükleyin.')
        with self.mutex,locked_file(self.path,create=True) as stream:
            # Also covers a first process dying between file creation and genesis.
            stream.seek(0,2)
            if stream.tell()==0:
                self.store_id=str(uuid.uuid4())
                append_frame(stream,{'kind':'genesis','store':self.store_id,'revision':1,
                    'data':{'version':1,'sheets':['Konular'],'topics':[]}})
            self._sync(stream)
            if self.data is None: raise Corruption('Başlangıç kaydı eksik; otomatik boş veriye geçilmedi.')
            if identity.exists():
                if json.loads(identity.read_text(encoding='utf-8')).get('store')!=self.store_id:
                    raise Corruption('Depo kimliği uyuşmuyor.')
            else:
                temporary=self.directory/(str(uuid.uuid4())+'.identity-tmp')
                with temporary.open('xb') as marker:
                    marker.write(encode({'store':self.store_id,'format':'is-takip-journal-v1'}));marker.flush();os.fsync(marker.fileno())
                os.replace(temporary,identity)
            protect_data_directory(self.path)
            protect_data_directory(identity)

    def _sync(self, stream):
        stream.seek(0,2)
        if stream.tell()<self.offset: raise Corruption('Veri dosyası küçülmüş. İstemcileri kapatıp dosyayı doğrulayın.')
        stream.seek(self.offset)
        while True:
            start=stream.tell();header=stream.read(HEADER.size)
            if not header: return False
            if len(header)<HEADER.size: return True
            magic,length=HEADER.unpack(header)
            if magic!=MAGIC or length>MAX_FRAME: raise Corruption('İşlem başlığı bozuk; dosya değiştirilmedi.')
            body=stream.read(length);digest=stream.read(32)
            if len(body)<length or len(digest)<32: return True
            if hashlib.sha256(body).digest()!=digest: raise Corruption('İşlem özeti uyuşmuyor; dosya değiştirilmedi.')
            try: event=json.loads(body)
            except (ValueError,UnicodeError) as e: raise Corruption('İşlem okunamadı.') from e
            if self.offset==0:
                if event.get('kind')!='genesis': raise Corruption('Başlangıç kaydı bulunamadı.')
                self.store_id=event['store'];self.data=validate(event['data']);self.revision=event['revision']
            else:
                if event.get('store')!=self.store_id or event.get('revision')!=self.revision+1: raise Corruption('İşlem sırası bozuk.')
                topics={t['id']:t for t in self.data['topics']}
                for ident in event['deleted']:topics.pop(ident,None)
                for topic in event['upserted']:topics[topic['id']]=topic
                self.data=validate({'sheets':event['sheets'],'topics':list(topics.values())})
                self.revision=event['revision']
                self.receipts[event['operation']]={'digest':event['request_hash'],'etag':self.etag}
            self.offset=stream.tell()

    def read(self):
        with self.mutex,locked_file(self.path) as stream:
            incomplete=self._sync(stream)
            if self.data is None: raise Corruption('Başlangıç kaydı eksik.')
            return copy.deepcopy(self.data),self.etag,incomplete

    def receipt(self, operation):
        with self.mutex,locked_file(self.path) as stream:
            self._sync(stream)
            return copy.deepcopy(self.receipts.get(operation))

    def write(self, data, expected, operation, actor):
        data=validate(data)
        if not isinstance(operation,str) or not 1<=len(operation)<=100: raise ValueError('İşlem kimliği gerekli.')
        request_hash=hashlib.sha256(encode(data)).hexdigest()
        with self.mutex,locked_file(self.path) as stream:
            incomplete=self._sync(stream)
            if operation in self.receipts:
                receipt=self.receipts[operation]
                if receipt['digest']!=request_hash: raise Conflict('İşlem kimliği farklı içerikle tekrar kullanıldı.')
                return receipt['etag']
            if expected!=self.etag: raise Conflict('Başka kullanıcı veriyi güncelledi.')
            if incomplete:
                # Only a trailing short frame can be removed, never a checksum failure.
                # Preserve it for diagnosis before trimming under the same file lock.
                recovery=self.directory/'kurtarma';recovery.mkdir(exist_ok=True)
                protect_data_directory(recovery)
                stream.seek(self.offset)
                with (recovery/(str(uuid.uuid4())+'.partial')).open('xb') as backup:
                    backup.write(stream.read());backup.flush();os.fsync(backup.fileno())
                stream.truncate(self.offset);stream.flush();os.fsync(stream.fileno())
            self._daily_backup()
            previous={t['id']:t for t in self.data['topics']};current={t['id']:t for t in data['topics']}
            event={'kind':'change','store':self.store_id,'revision':self.revision+1,
                   'time':datetime.now(timezone.utc).isoformat(),'actor':actor,'operation':operation,
                   'request_hash':request_hash,'deleted':sorted(previous.keys()-current.keys()),
                   'upserted':[t for key,t in current.items() if previous.get(key)!=t],'sheets':data['sheets']}
            stream.seek(self.offset);append_frame(stream,event)
            self._sync(stream)
            return self.etag

    def _daily_backup(self):
        folder=self.directory/'yedekler';folder.mkdir(exist_ok=True)
        protect_data_directory(folder)
        # A server-independent calendar date is sufficient for backup naming; UTC is explicit.
        final=folder/(datetime.now(timezone.utc).strftime('%Y-%m-%d')+'-UTC.json')
        if final.exists():
            try: validate(json.loads(final.read_text(encoding='utf-8'))['data'])
            except (ValueError,KeyError): raise Corruption('Günlük yedek okunamadı; işlem durduruldu.')
            return
        temporary=folder/(str(uuid.uuid4())+'.tmp')
        with temporary.open('xb') as backup:
            backup.write(encode({'store':self.store_id,'revision':self.revision,'data':self.data}))
            backup.flush();os.fsync(backup.fileno())
        os.replace(temporary,final)
