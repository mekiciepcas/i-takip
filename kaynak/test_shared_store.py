import concurrent.futures
import ctypes
import multiprocessing
import os
from pathlib import Path
import shutil
import tempfile
import time
import unittest
from desktop import data_path_forbidden
from shared_store import Store,Conflict,Corruption,locked_file

def add_topic(directory, number):
    store=Store(directory);store.initialize()
    for attempt in range(100):
        data,etag,_=store.read()
        data['topics'].append({'id':str(number),'sheet':'Konular','topic':f'Konu {number}',
            'status':'Aktif','priority':'3','updates':[]})
        try:
            store.write(data,etag,'operation-'+str(number),'test')
            return number
        except Conflict:time.sleep(.005)
    raise AssertionError('Yeniden deneme sınırı')

def stale_write(directory,etag,number):
    store=Store(directory);store.initialize()
    data={'version':1,'sheets':['Konular'],'topics':[]}
    try:store.write(data,etag,'stale-'+str(number),'test');return 'saved'
    except Conflict:return 'conflict'

def hold_lock(path,event):
    with locked_file(Path(path)):
        event.set();time.sleep(60)

class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.directory=Path(self.temp.name)/'veri'
        self.store=Store(self.directory);self.store.initialize()
    def tearDown(self):self.temp.cleanup()
    def test_20_processes_preserve_all_changes(self):
        with concurrent.futures.ProcessPoolExecutor(max_workers=20) as pool:
            results=list(pool.map(add_topic,[str(self.directory)]*20,range(20)))
        data,_,_=self.store.read()
        self.assertEqual(len(results),20);self.assertEqual(len(data['topics']),20)
        fresh=Store(self.directory);fresh.initialize();self.assertEqual(fresh.read()[0],data)
    def test_20_stale_writers_only_one_succeeds(self):
        _,etag,_=self.store.read()
        with concurrent.futures.ProcessPoolExecutor(max_workers=20) as pool:
            results=list(pool.map(stale_write,[str(self.directory)]*20,[etag]*20,range(20)))
        self.assertEqual(results.count('saved'),1);self.assertEqual(results.count('conflict'),19)
    def test_idempotent_receipt_after_restart(self):
        data,etag,_=self.store.read();saved=self.store.write(data,etag,'same','test')
        fresh=Store(self.directory);fresh.initialize()
        self.assertEqual(fresh.write(data,etag,'same','test'),saved)
        self.assertEqual(fresh.receipt('same')['etag'],saved)
        self.assertEqual(fresh.revision,2)
    def test_partial_tail_is_preserved_and_recovered(self):
        data,etag,_=self.store.read()
        with locked_file(self.store.path) as f:f.seek(0,2);f.write(b'IST');os.fsync(f.fileno())
        self.assertTrue(self.store.read()[2])
        self.store.write(data,etag,'recovery','test')
        self.assertFalse(self.store.read()[2]);self.assertEqual(len(list((self.directory/'kurtarma').glob('*.partial'))),1)
    def test_corrupt_complete_frame_fails_closed(self):
        with locked_file(self.store.path) as f:f.seek(-1,2);f.write(b'x');os.fsync(f.fileno())
        before=self.store.path.read_bytes()
        with self.assertRaises(Corruption):Store(self.directory).initialize()
        self.assertEqual(self.store.path.read_bytes(),before)
    def test_process_crash_releases_os_lock(self):
        event=multiprocessing.Event();process=multiprocessing.Process(target=hold_lock,args=(str(self.store.path),event))
        process.start();self.assertTrue(event.wait(10));process.terminate();process.join(10)
        self.assertFalse(process.is_alive());self.assertIsNotNone(self.store.read()[0])
    def test_relocation_and_missing_file(self):
        destination=Path(self.temp.name)/'moved';shutil.move(self.directory,destination)
        with self.assertRaises(OSError):self.store.read()
        self.assertFalse(self.directory.exists())
        moved=Store(destination);moved.initialize();self.assertEqual(moved.read()[1],self.store.etag)
    def test_backup_before_first_write(self):
        data,etag,_=self.store.read();self.store.write(data,etag,'backup','test')
        self.assertEqual(len(list((self.directory/'yedekler').glob('*.json'))),1)
    def test_legacy_excel_text_is_not_rejected(self):
        data,etag,_=self.store.read()
        note='Uzun haftalık açıklama. '*200
        data['topics']=[{'id':'excel','sheet':'Konular','topic':'Eski Excel konusu','status':'Aktif',
            'priority':'5','closingDate':'Planlanıyor','current':note,'updates':[{'id':'u','date':'26.10.2026','note':note}]}]
        self.store.write(data,etag,'excel','test')
        fresh=Store(self.directory);fresh.initialize()
        self.assertEqual(fresh.read()[0]['topics'][0]['updates'][0]['note'],note)
        self.assertEqual(fresh.read()[0]['topics'][0]['closingDate'],'Planlanıyor')
    def test_missing_database_is_not_recreated_on_restart(self):
        self.store.path.unlink()
        with self.assertRaises(Corruption):Store(self.directory).initialize()
        self.assertFalse(self.store.path.exists())
    def test_data_directory_is_hidden_from_explorer(self):
        attrs=ctypes.windll.kernel32.GetFileAttributesW(str(self.directory))
        self.assertNotEqual(attrs,-1)
        self.assertTrue(attrs & 0x2)
        self.assertTrue(attrs & 0x4)
    def test_http_paths_to_data_folder_are_forbidden(self):
        for path in ('/veri','/veri/is-takip.db','/veri/yedekler/2026-10-26-UTC.json','/../veri/is-takip.db','/depo-kimligi.json'):
            self.assertTrue(data_path_forbidden(path), path)
        self.assertFalse(data_path_forbidden('/'))
        self.assertFalse(data_path_forbidden('/api/data'))
        self.assertFalse(data_path_forbidden('/assets/xlsx.full.min.js'))

if __name__=='__main__':
    multiprocessing.freeze_support();unittest.main(verbosity=2)
