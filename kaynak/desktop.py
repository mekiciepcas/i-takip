"""Portable per-user client. Loopback HTTP is only a UI bridge, never a shared server."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse,parse_qs
import argparse
import ctypes
import getpass
import json
import secrets
import sys
import threading
import webbrowser
from shared_store import Store,Conflict,Corruption,Busy

ROOT=Path(sys.executable).resolve().parent if getattr(sys,'frozen',False) else Path(__file__).resolve().parent.parent
DATA_DIR_NAME='veri'

def data_path_forbidden(url_path):
    raw=(url_path or '').split('?',1)[0]
    normalized=raw.replace('\\','/').lower()
    while '//' in normalized: normalized=normalized.replace('//','/')
    parts=[part for part in normalized.split('/') if part]
    if '..' in parts or '.' in parts: return True
    blocked={DATA_DIR_NAME,'yedekler','kurtarma','is-takip.db','depo-kimligi.json'}
    return any(part in blocked or part.endswith('.partial') or part.endswith('-utc.json') for part in parts)

def served_file(root, url_path):
    files={'/':Path(root)/'uygulama'/'index.html','/index.html':Path(root)/'uygulama'/'index.html','/haftalik-rapor-v2.html':Path(root)/'haftalik-rapor-v2.html','/assets/xlsx.full.min.js':Path(root)/'assets'/'xlsx.full.min.js'}
    if url_path not in files: return None
    target=files[url_path].resolve()
    data_root=(Path(root)/DATA_DIR_NAME).resolve()
    if target==data_root or data_root in target.parents: return None
    return target

def build_server(root,port=0):
    store=Store(Path(root)/'veri');store.initialize()
    token=secrets.token_urlsafe(32)
    actor=getpass.getuser()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def reply(self,status,data,etag=None):
            body=json.dumps(data,ensure_ascii=False).encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type','application/json; charset=utf-8')
            self.send_header('Content-Length',str(len(body)))
            self.send_header('Cache-Control','no-store')
            self.send_header('X-Content-Type-Options','nosniff')
            if etag:self.send_header('ETag',etag)
            self.end_headers();self.wfile.write(body)
        def trusted(self):
            # Host validation prevents DNS rebinding. Cookie restricts local API to the opened UI.
            if self.headers.get('Host')!=f'127.0.0.1:{self.server.server_port}':return False
            from http.cookies import SimpleCookie
            cookie=SimpleCookie(self.headers.get('Cookie',''))
            name=f'is_takip_{self.server.server_port}'
            return cookie.get(name) is not None and secrets.compare_digest(cookie[name].value,token)
        def error(self,error):
            if isinstance(error,Conflict):return self.reply(412,{'error':str(error)})
            if isinstance(error,ValueError):return self.reply(400,{'error':str(error)})
            if isinstance(error,Corruption):return self.reply(503,{'error':str(error),'recoveryRequired':True})
            return self.reply(503,{'error':'Ortak klasöre erişilemiyor veya dosya meşgul. Değişikliklerinizi koruyun ve yeniden deneyin.'})
        def do_GET(self):
            path=urlparse(self.path)
            if data_path_forbidden(path.path): return self.reply(403,{'error':'Veri klasörüne erişim yasak.'})
            if path.path=='/' and parse_qs(path.query).get('session')==[token] and self.headers.get('Host')==f'127.0.0.1:{self.server.server_port}':
                self.send_response(303);self.send_header('Location','/haftalik-rapor-v2.html' if parse_qs(path.query).get('view')==['v2'] else '/')
                self.send_header('Set-Cookie',f'is_takip_{self.server.server_port}={token}; HttpOnly; SameSite=Strict; Path=/')
                self.send_header('Content-Length','0');self.end_headers();return
            if not self.trusted():return self.reply(403,{'error':'Uygulamayı İş Takip kısayolundan açın.'})
            try:
                if path.path=='/api/data':
                    data,etag,incomplete=store.read()
                    if incomplete:data['recoveryWarning']='Yarım kalan son işlem yok sayıldı; sonraki yazmada kurtarma kopyası alınacak.'
                    return self.reply(200,data,etag)
                if path.path=='/api/receipt':
                    result=store.receipt(parse_qs(path.query).get('id',[''])[0])
                    return self.reply(200,{'committed':result is not None,'result':result})
                target=served_file(root, path.path)
                if target is None:return self.reply(404,{'error':'Bulunamadı.'})
                body=target.read_bytes()
                # Preserve the v2 file and generator byte-for-byte; only redirect its
                # existing library URL to the same version bundled beside the client.
                if path.path.endswith('.html') or path.path=='/':
                    body=body.replace(b'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',b'/assets/xlsx.full.min.js')
                self.send_response(200);self.send_header('Content-Type','text/javascript; charset=utf-8' if path.path.endswith('.js') else 'text/html; charset=utf-8')
                self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(body)))
                self.end_headers();self.wfile.write(body)
            except (OSError,ValueError,Corruption,Busy) as error:self.error(error)
        def do_PUT(self):
            if data_path_forbidden(urlparse(self.path).path): return self.reply(403,{'error':'Veri klasörüne erişim yasak.'})
            if not self.trusted() or self.headers.get('Origin',f'http://127.0.0.1:{self.server.server_port}')!=f'http://127.0.0.1:{self.server.server_port}':
                return self.reply(403,{'error':'Kaynak reddedildi.'})
            if urlparse(self.path).path!='/api/data':return self.reply(404,{'error':'Bulunamadı.'})
            if not self.headers.get('If-Match'):return self.reply(428,{'error':'Sürüm gerekli.'})
            try:
                length=int(self.headers.get('Content-Length','0'))
                if not 0<length<=9*1024*1024:return self.reply(413,{'error':'İstek boyutu geçersiz.'})
                data=json.loads(self.rfile.read(length))
                etag=store.write(data,self.headers['If-Match'],self.headers.get('Idempotency-Key'),actor)
                self.reply(200,{'ok':True},etag)
            except (OSError,ValueError,Corruption,Busy,Conflict) as error:self.error(error)
    server=ThreadingHTTPServer(('127.0.0.1',port),Handler)
    return server,f'http://127.0.0.1:{server.server_port}/?session={token}',store

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--headless',action='store_true',help='Test/terminal mode; do not open a window.')
    parser.add_argument('--root',type=Path,default=ROOT,help='Package folder, for isolated tests.')
    parser.add_argument('--port',type=int,default=0)
    parser.add_argument('--legacy',action='store_true',help='Open the original Excel screen.')
    parser.add_argument('--ready-file',type=Path,help='Write launch URL for automated tests.')
    args=parser.parse_args()
    server,url,store=build_server(args.root,args.port)
    if args.legacy:url+='&view=v2'
    if args.ready_file:args.ready_file.write_text(url,encoding='utf-8')
    if args.headless:
        if sys.stdout:print(url,flush=True)
        try:server.serve_forever()
        except KeyboardInterrupt:pass
        finally:server.server_close()
        return
    import tkinter as tk
    from tkinter import ttk,messagebox
    thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
    window=tk.Tk();window.title('İş Takip · Ağ klasörü');window.geometry('600x230')
    window.configure(padx=22,pady=20)
    ttk.Label(window,text='İş Takip açık',font=('Segoe UI',16,'bold')).pack(anchor='w')
    ttk.Label(window,text='Ortak klasör bağlantısı arka planda çalışıyor.\nÇalışma ekranını aşağıdaki düğmeyle yeniden açabilirsiniz.\nİş Takip kullanılırken bu yardımcıyı kapatmayın.',wraplength=550).pack(anchor='w',pady=10)
    ttk.Button(window,text='Çalışma ekranını aç',command=lambda:webbrowser.open(url)).pack(anchor='w',pady=14)
    def close():
        if not messagebox.askokcancel('İş Takip','Önce tarayıcıdaki değişiklikleri kaydedin. Bu bilgisayardaki İş Takip istemcisi kapatılsın mı?'):return
        server.shutdown();server.server_close();window.destroy()
    window.protocol('WM_DELETE_WINDOW',close)
    window.iconify()
    webbrowser.open(url);window.mainloop()

if __name__=='__main__':
    try:main()
    except Exception as error:
        if '--headless' in sys.argv:raise
        ctypes.windll.user32.MessageBoxW(None,'İş Takip açılamadı. Ağ klasörü erişimini ve yazma iznini kontrol edin.','İş Takip',0x10)
