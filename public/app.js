(() => {
      'use strict';
      const $ = id => document.getElementById(id);
      let storage=null, chosenDirectory=null;
      const state = {
        topics: [], sheets: ['Konular'], activeSheet: 'all',
        projectStorage: false, backend: 'browser',
        baseTopics: [], baseSheets: ['Konular'], remoteEtag: null,
        pendingRemoteEtag: null, syncError: null, cacheWarning: null,
        localFallbackLoaded: false, saving: false
      };
      const form = $('topicForm');
      const serviceOptions = $('serviceOptions');
      let serviceTags = [];
      const norm = value => String(value || '').toLocaleLowerCase('tr-TR')
        .replace(/[ıİ]/g, 'i').replace(/[şŞ]/g, 's').replace(/[ğĞ]/g, 'g')
        .replace(/[üÜ]/g, 'u').replace(/[öÖ]/g, 'o').replace(/[çÇ]/g, 'c').trim();
      const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
        '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
      })[char]);
      const announce = (message, type = 'info') => {
        const notice = $('notice');
        notice.textContent = message;
        notice.className = `notice show ${type}`;
        clearTimeout(announce.timer);
        if(type!=='error') announce.timer = setTimeout(() => notice.classList.remove('show'), 8000);
      };
      const formatDate = value => {
        if (!value) return '';
        const date = new Date(`${value}T00:00:00`);
        return Number.isNaN(date.getTime()) ? value : new Intl.DateTimeFormat('tr-TR').format(date);
      };
      const localDate = () => {
        const date = new Date();
        return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      };
      const priorityValue = value => {
        const match = String(value || '').match(/[1-5]/);
        return match ? match[0] : '';
      };
      const normalizeStatus = value => {
        const status = norm(value);
        if (status.includes('kapan') || status.includes('tamam') || status.includes('bitti')) return 'Kapandı';
        if (status.includes('aski') || status.includes('bekli') || status.includes('baslamadi') || status.includes('planlan')) return 'Askıda';
        return 'Aktif';
      };
      const statusKind = status => status === 'Kapandı' ? 'closed' : status === 'Askıda' ? 'hold' : 'active';
      function updateFormBadgeColors() {
        $('priority').className = `level-${priorityValue($('priority').value) || '0'}`;
        $('status').className = statusKind($('status').value);
      }
      const announceSaved = message => {
        const details = [
          state.projectStorage ? '' : 'Yalnızca bu tarayıcıya kaydedildi; henüz ortak dosyaya yazılmadı.',
          state.cacheWarning ? `Tarayıcı yedeği oluşturulamadı: ${state.cacheWarning}` : ''
        ].filter(Boolean).join(' ');
        announce(details ? `${message} ${details}` : message, details ? 'warning' : 'success');
      };
      const dateKey = value => {
        const text = String(value || '');
        if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
        const match = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
        return match ? `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}` : '';
      };
      const calendarDateValue = value => {
        const key = dateKey(value);
        if (!key) return '';
        const date = new Date(`${key}T00:00:00`);
        return !Number.isNaN(date.getTime()) &&
          `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` === key
          ? key : '';
      };
      const weekRangeLabel = value => {
        const key = dateKey(value);
        if (!key) return '';
        const monday = new Date(`${key}T00:00:00`);
        const localKey = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
        if (Number.isNaN(monday.getTime()) || localKey !== key) return '';
        monday.setDate(monday.getDate() - (monday.getDay() + 6) % 7);
        const friday = new Date(monday);
        friday.setDate(friday.getDate() + 4);
        const toIso = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
        const shortDate = date => new Intl.DateTimeFormat('tr-TR', { day: 'numeric', month: 'long' }).format(date);
        if (monday.getFullYear() !== friday.getFullYear()) {
          return `${formatDate(toIso(monday))} - ${formatDate(toIso(friday))} haftası`;
        }
        return `${shortDate(monday)} - ${shortDate(friday)} haftası ${friday.getFullYear()}`;
      };
      const updateDateLabel = value => {
        const key = dateKey(value);
        return key ? formatDate(key) : String(value || 'Tarih belirtilmedi');
      };
      const orderedUpdates = updates => {
        const items = [...(updates || [])];
        return items.every(update => dateKey(update.date))
          ? items.sort((a, b) => dateKey(a.date).localeCompare(dateKey(b.date)))
          : items;
      };
      const orderedWeeklyLabels = labels => {
        const unique = uniqueNames(labels);
        if (unique.every(label => dateKey(label))) return unique.sort((a, b) => dateKey(a).localeCompare(dateKey(b)));
        const months = new Map(['ocak','şubat','mart','nisan','mayıs','haziran','temmuz','ağustos','eylül','ekim','kasım','aralık'].map((month, index) => [month, String(index + 1).padStart(2, '0')]));
        const weekStartKey = label => {
          const match = String(label).match(/^(\d{1,2})\s+([^\s]+)(?:\s+(\d{4}))?/);
          if (!match) return '';
          const year = match[3] || String(label).match(/(\d{4})(?:\s*-\s*\d{4})?\s*$/)?.[1];
          const month = months.get(match[2].toLocaleLowerCase('tr-TR'));
          return year && month ? `${year}-${month}-${match[1].padStart(2, '0')}` : '';
        };
        const keys = unique.map(weekStartKey);
        return keys.every(Boolean) ? unique.sort((a, b) => weekStartKey(a).localeCompare(weekStartKey(b))) : unique;
      };
      const latestUpdate = topic => orderedUpdates(topic.updates).at(-1) || null;
      const copy = value => JSON.parse(JSON.stringify(value));
      const uniqueNames = values => {
        const names = new Map();
        // Sheet names are identities, not search terms. Preserve spaces and accents
        // exactly as V2/Excel do; "İş", "Is" and " Sayfa " must not be collapsed.
        values.map(value => String(value ?? '')).filter(value=>value.trim()).forEach(value => {
          if (!names.has(value)) names.set(value, value);
        });
        return [...names.values()];
      };
      const parseServiceTags = value => uniqueNames(String(value || '').split(',').map(item => item.trim()).filter(Boolean));
      const serviceTagMarkup = (service, index, removable = false) =>
        `<span class="service-tag">${escapeHtml(service)}${removable ? `<button type="button" data-remove-service="${index}" aria-label="${escapeHtml(service)} etiketini kaldır">×</button>` : ''}</span>`;
      function renderServiceTags() {
        $('serviceTags').innerHTML = serviceTags.map((service, index) => serviceTagMarkup(service, index, true)).join('');
        $('service').value = serviceTags.join(', ');
      }
      function addServiceTags(values) {
        const additions = parseServiceTags(values);
        additions.forEach(service => {
          if (!serviceTags.some(existing => norm(existing) === norm(service))) serviceTags.push(service);
        });
        renderServiceTags();
      }
      function commitServiceEntry() {
        const input = $('serviceTagInput');
        if (!input.value.trim()) return;
        addServiceTags(input.value);
        input.value = '';
      }
      const odata = value => String(value).replace(/'/g, "''");
      const responseEtag = (data, response) =>
        data?.ETag || data?.etag || data?.['odata.etag'] ||
        data?.d?.__metadata?.etag || response.headers.get('ETag');


      function mergeTopics(baseTopics, localTopics, remoteTopics) {
        const base = new Map(baseTopics.map(topic => [topic.id, topic]));
        const local = new Map(localTopics.map(topic => [topic.id, topic]));
        const remote = new Map(remoteTopics.map(topic => [topic.id, topic]));
        const merged = [];
        const conflicts = [];
        const conflictIds = new Set();
        const addConflict = (id, topic) => {
          conflicts.push(topic);
          conflictIds.add(id);
        };
        const fields = ['owner', 'sheet', 'topic', 'service', 'topicType', 'priority', 'status', 'closingDate', 'current'];
        for (const id of new Set([...base.keys(), ...local.keys(), ...remote.keys()])) {
          const before = base.get(id);
          const ours = local.get(id);
          const theirs = remote.get(id);
          if (!before) {
            if (ours && theirs && JSON.stringify(ours) !== JSON.stringify(theirs)) addConflict(id, ours.topic);
            else if (ours || theirs) merged.push(copy(ours || theirs));
            continue;
          }
          if (!ours && !theirs) continue;
          if (!ours) {
            if (JSON.stringify(before) !== JSON.stringify(theirs)) addConflict(id, before.topic);
            continue;
          }
          if (!theirs) {
            if (JSON.stringify(before) !== JSON.stringify(ours)) addConflict(id, ours.topic);
            continue;
          }
          const result = copy(theirs);
          for (const field of fields) {
            const localChanged = ours[field] !== before[field];
            const remoteChanged = theirs[field] !== before[field];
            if (localChanged && remoteChanged && ours[field] !== theirs[field]) {
              addConflict(id, ours.topic);
              result[field] = ours[field];
            } else if (localChanged) result[field] = ours[field];
          }
          const baseUpdates = new Map((before.updates || []).map(update => [update.id, update]));
          const localUpdates = new Map((ours.updates || []).map(update => [update.id, update]));
          const remoteUpdates = new Map((theirs.updates || []).map(update => [update.id, update]));
          const updates = [];
          for (const updateId of new Set([...baseUpdates.keys(), ...localUpdates.keys(), ...remoteUpdates.keys()])) {
            const oldUpdate = baseUpdates.get(updateId);
            const localUpdate = localUpdates.get(updateId);
            const remoteUpdate = remoteUpdates.get(updateId);
            if (!oldUpdate) {
              const addition = localUpdate || remoteUpdate;
              if (localUpdate && remoteUpdate && JSON.stringify(localUpdate) !== JSON.stringify(remoteUpdate)) addConflict(id, ours.topic);
              if (addition) updates.push(copy(addition));
            } else if (!localUpdate && !remoteUpdate) {
              continue;
            } else if (!localUpdate) {
              if (JSON.stringify(oldUpdate) !== JSON.stringify(remoteUpdate)) addConflict(id, ours.topic);
            } else if (!remoteUpdate) {
              if (JSON.stringify(oldUpdate) !== JSON.stringify(localUpdate)) addConflict(id, ours.topic);
            } else if (JSON.stringify(localUpdate) !== JSON.stringify(oldUpdate) &&
                       JSON.stringify(remoteUpdate) !== JSON.stringify(oldUpdate) &&
                       JSON.stringify(localUpdate) !== JSON.stringify(remoteUpdate)) {
              addConflict(id, ours.topic);
            } else {
              updates.push(copy(JSON.stringify(localUpdate) !== JSON.stringify(oldUpdate) ? localUpdate : remoteUpdate));
            }
          }
          result.updates = updates;
          merged.push(result);
        }
        return { topics: merged, conflicts: uniqueNames(conflicts), conflictIds: [...conflictIds] };
      }

      function setStorageLabel(){
        $('saveStatus').textContent=storage?(state.projectStorage?(storage.kind==='json'?'JSON · '+storage.file.name:'PostgreSQL · '+(state.username||'')):'Bağlantı yok · taslak korunuyor'):'Veri kaynağı bekleniyor';
        $('saveStatus').classList.toggle('offline',!state.projectStorage);
      }
      function acceptSnapshot(remote){
        const data=validateData(remote.data);
        state.topics=data.topics;state.sheets=data.sheets;state.baseTopics=copy(data.topics);state.baseSheets=[...data.sheets];state.remoteEtag=remote.etag;
      }
      async function persist(topics=state.topics,sheets=state.sheets){
        if(!storage){announce('Önce veri kaynağını bağlayın.','error');return false;}
        if(uncertainWrite){announce('Önce İşlem sonucunu denetle düğmesini kullanın.','error');return false;}
        if(gridDrafts.size&&!gridSaving){announce('Önce tablo değişikliklerini kaydedin.','error');return false;}
        if(state.saving)return false;
        if(new TextEncoder().encode(JSON.stringify({topics,sheets})).length>9*1024*1024){announce('Veri 9 MB sınırını aşıyor.','error');return false;}
        state.saving=true;
        try{
          const original=copy(topics),base=copy(state.baseTopics);
          for(let attempt=0;attempt<3;attempt++){
            const remote=await storage.read(),data=validateData(remote.data);
            const merged=mergeTopics(base,original,data.topics);
            if(merged.conflicts.length)throw new Error('Aynı alan başka kullanıcı tarafından değiştirildi. Taslağınız korunuyor; taslağı indirin ve güncel verilerle karşılaştırın.');
            const mergedSheets=uniqueNames([...data.sheets,...sheets]);
            const operationId=crypto.randomUUID();
            uncertainWrite={operationId,grid:gridSaving};
            let result;
            try{result=await storage.write({version:1,topics:merged.topics,sheets:mergedSheets},remote.etag,operationId);}
            catch(error){
              if(error.status&&error.status<500)uncertainWrite=null;
              if(error.status===412)continue;
              throw error;
            }
            uncertainWrite=null;
            acceptSnapshot({data:{topics:merged.topics,sheets:mergedSheets},etag:result.etag});
            state.projectStorage=true;setStorageLabel();return true;
          }
          throw new Error('Veri art arda değişti; yeniden deneyin.');
        }catch(error){
          state.projectStorage=false;setStorageLabel();
          announce('Kayıt tamamlanamadı: '+error.message+' Taslağınız bu sekmede korunuyor.','error');return false;
        }finally{state.saving=false;lockUncertainUI();}
      }
      function hasDraft(){return gridDrafts.size||state.saving||uncertainWrite||form.dataset.dirty==='true'||$('quickTopic').value.trim()||$('weeklyDialog').open;}
      async function connectStorage(candidate){
        const remote=await candidate.read();
        const data=validateData(remote.data); // Validate before replacing the current workspace.
        storage=candidate;acceptSnapshot({data,etag:remote.etag});
        state.backend=candidate.kind;state.projectStorage=true;saveFailed=false;
        setStorageLabel();lockUncertainUI();render();
        $('storageBanner').textContent=candidate.kind==='json'
          ? 'Yerel JSON modu · Tek düzenleyici kullanın. Dosya bu sekme açıkken 3 saniyede bir okunur; her yazmadan önce yedek alınır. Eşzamanlı ekip çalışması için PostgreSQL sürümünü kullanın.'
          : 'Ortak çalışma · PostgreSQL bağlantısı hazır. Kayıtlar kullanıcı hesabınızla işlenir; ekran boşta iken 3 saniyede bir yenilenir.';
      }
      async function loadData(){
        render();lockUncertainUI();
        if(location.protocol==='file:'){
          $('connectFolder').hidden=false;
          $('storageBanner').textContent='Yerel JSON modu · Başlamak için JSON klasörünü seçin. Tarayıcı izni yalnız seçtiğiniz klasör içindir. Chrome veya Edge kullanın; Python veya EXE gerekmez.';
          return;
        }
        $('loginBtn').hidden=false;
        const candidate=new IsTakipStorage.ApiStorage();
        try{
          state.username=(await candidate.me()).username;
          await connectStorage(candidate);$('logoutBtn').hidden=false;
        }catch(error){
          if(error.status===401)$('loginDialog').showModal();
          else{$('storageBanner').textContent='Sunucu bağlantısı kurulamadı. Node.js hizmetini ve PostgreSQL bağlantısını kontrol edin. Yerel JSON için indirilen pakette public/index.html dosyasını açın.';announce(error.message,'error');}
        }
      }
      $('loginBtn').onclick=()=>{$('loginError').textContent='';$('loginDialog').showModal();};
      $('loginForm').onsubmit=async event=>{
        event.preventDefault();const button=$('loginSubmit');button.disabled=true;$('loginError').textContent='';
        try{
          const candidate=new IsTakipStorage.ApiStorage();
          const user=await candidate.login($('username').value.trim(),$('password').value);
          state.username=user.username;
          if(!storage)await connectStorage(candidate);else{state.projectStorage=true;setStorageLabel();}
          $('password').value='';$('loginDialog').close();$('logoutBtn').hidden=false;
        }catch(error){$('loginError').textContent=error.message;}finally{button.disabled=false;}
      };
      $('logoutBtn').onclick=async()=>{
        if(hasDraft())return announce('Çıkış yapmadan önce taslaklarınızı kaydedin veya geri alın.','error');
        try{await storage.logout();location.reload();}catch(error){announce(error.message,'error');}
      };
      $('connectFolder').onclick=async()=>{
        if(hasDraft())return announce('Klasör değiştirmeden önce taslaklarınızı kaydedin.','error');
        if(!window.showDirectoryPicker)return announce('Bu tarayıcı klasör erişimini desteklemiyor. Güncel Chrome veya Edge kullanın.','error');
        try{
          chosenDirectory=await window.showDirectoryPicker({mode:'readwrite'});
          const files=[];for await(const [name,handle] of chosenDirectory.entries())if(handle.kind==='file'&&name.toLowerCase().endsWith('.json'))files.push(name);
          $('jsonChoice').innerHTML=files.sort((a,b)=>a.localeCompare(b,'tr')).map(name=>`<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('');
          $('openJson').disabled=!files.length;$('folderError').textContent='';$('folderName').textContent=chosenDirectory.name;
          $('folderDialog').showModal();
        }catch(error){if(error.name!=='AbortError')announce(error.message,'error');}
      };
      $('openJson').onclick=async()=>{
        const button=$('openJson');button.disabled=true;
        try{
          const file=await chosenDirectory.getFileHandle($('jsonChoice').value);
          await connectStorage(new IsTakipStorage.JsonStorage(chosenDirectory,file));$('folderDialog').close();
        }catch(error){$('folderError').textContent=error.message;}finally{button.disabled=false;}
      };
      $('createJson').onclick=async()=>{
        const button=$('createJson');button.disabled=true;
        try{
          const name='is-takip-v2.5.json';
          try{await chosenDirectory.getFileHandle(name);throw new Error(name+' zaten var. Listeden seçip açın; üzerine yazılmadı.');}catch(error){if(error.name!=='NotFoundError')throw error;}
          const file=await chosenDirectory.getFileHandle(name,{create:true});
          const writable=await file.createWritable();await writable.write(JSON.stringify({version:1,sheets:['Konular'],topics:[]},null,2));await writable.close();
          await connectStorage(new IsTakipStorage.JsonStorage(chosenDirectory,file));$('folderDialog').close();
        }catch(error){$('folderError').textContent=error.message;}finally{button.disabled=false;}
      };

      function validateData(data) {
        if (!data || !Array.isArray(data.topics)) throw new Error('JSON içinde topics dizisi bulunamadı.');
        if (data.topics.length > 10000) throw new Error('En fazla 10.000 konu yüklenebilir.');
        const topics = data.topics.map(item => {
          if (!item || typeof item.topic !== 'string' || !item.topic.trim()) throw new Error('Bir konu kaydında konu adı eksik.');
          return {
            id: String(item.id || crypto.randomUUID()),
            sheet: String(item.sheet || 'Konular'),
            topic: item.topic.trim(),
            service: String(item.service || ''),
            owner: String(item.owner || ''),
            topicType: String(item.topicType || ''),
            priority: priorityValue(item.priority),
            status: normalizeStatus(item.status),
            closingDate: String(item.closingDate || ''),
            current: String(item.current || ''),
            updates: Array.isArray(item.updates) ? item.updates.map((update, index) => ({
              id: String(update.id || `legacy-${index}-${update.date || ''}-${update.note || ''}`),
              date: String(update.date || ''),
              note: String(update.note || '')
            })) : []
          };
        });
        if(new Set(topics.map(t=>t.id)).size!==topics.length)throw new Error('Konu kimlikleri yineleniyor.');
        const sheets = uniqueNames([...(Array.isArray(data.sheets) ? data.sheets : []), ...topics.map(topic => topic.sheet)]);
        const canonicalSheets = sheets.length ? sheets : ['Konular'];
        if (canonicalSheets.length > 200) throw new Error('En fazla 200 sayfa kullanılabilir.');
        if (canonicalSheets.some(sheet => sheet.length > 31 || /[\\/:*?\[\]]/.test(sheet))) {
          throw new Error('Sayfa adları 31 karakteri aşamaz ve \\/:*?[] karakterlerini içeremez.');
        }
        topics.forEach(topic => {
          topic.sheet = canonicalSheets.includes(topic.sheet) ? topic.sheet : 'Konular';
        });
        return { topics, sheets: canonicalSheets };
      }

      function render() {
        updateFormBadgeColors();
        const services = uniqueNames(state.topics.flatMap(topic => parseServiceTags(topic.service))).sort((a, b) => a.localeCompare(b, 'tr'));
        if (form.dataset.dirty !== 'true' && !$('topicId').value) {
          serviceTags = parseServiceTags($('service').value);
          renderServiceTags();
        }
        const priorService = $('serviceFilter').value;
        const preserveFormSheet = form.dataset.dirty === 'true' || Boolean($('topicId').value);
        const priorTopicSheet = $('topicSheet').value;
        $('topicSheet').innerHTML = state.sheets.map(sheet => `<option value="${escapeHtml(sheet)}">${escapeHtml(sheet)}</option>`).join('');
        $('topicSheet').value = preserveFormSheet && state.sheets.includes(priorTopicSheet)
          ? priorTopicSheet
          : (state.activeSheet !== 'all' && state.sheets.includes(state.activeSheet) ? state.activeSheet : state.sheets[0]);
        $('sheetBar').innerHTML = `<button class="sheet-tab ${state.activeSheet === 'all' ? 'active' : ''}" type="button" data-sheet="all">Tüm sayfalar <span>${state.topics.length}</span></button>` +
          state.sheets.map(sheet => `<button class="sheet-tab ${state.activeSheet === sheet ? 'active' : ''}" type="button" data-sheet="${escapeHtml(sheet)}">${escapeHtml(sheet)} <span>${state.topics.filter(topic => topic.sheet === sheet).length}</span></button>`).join('') +
          '<button class="sheet-tab add" type="button" id="newSheetBtn">+ Yeni sayfa</button>';
        $('serviceFilter').innerHTML = '<option value="">Tüm servisler</option>' + services.map(service => `<option value="${escapeHtml(service)}">${escapeHtml(service)}</option>`).join('');
        if (services.includes(priorService)) $('serviceFilter').value = priorService;
        serviceOptions.innerHTML = services.map(service => `<option value="${escapeHtml(service)}"></option>`).join('');
        const filtered = getFilteredTopics();
        const activeFilters = [
          quickFilter !== 'all' ? document.querySelector('[data-quick].active')?.textContent : '',
          state.activeSheet !== 'all' ? `Sayfa: ${state.activeSheet}` : '',
          $('statusFilter').value ? `Durum: ${$('statusFilter').value}` : '',
          $('priorityFilter').value ? `Önem: ${$('priorityFilter').value === 'none' ? 'belirtilmedi' : $('priorityFilter').value}` : '',
          $('serviceFilter').value ? `Servis: ${$('serviceFilter').value}` : '',
          $('searchInput').value.trim() ? `Arama: ${$('searchInput').value.trim()}` : ''
        ].filter(Boolean);
        $('activeFilterSummary').textContent = activeFilters.length ? activeFilters.join(' · ') : 'Tüm konular görüntüleniyor';
        $('clearFiltersBtn').disabled = activeFilters.length === 0;
        $('clearFiltersBtn').style.opacity = activeFilters.length ? '1' : '.55';
        $('totalCount').textContent = state.topics.length;
        $('activeCount').textContent = state.topics.filter(topic => topic.status === 'Aktif').length;
        $('closedCount').textContent = state.topics.filter(topic => topic.status === 'Kapandı').length;
        $('holdCount').textContent = state.topics.filter(topic => topic.status === 'Askıda').length;
        $('resultCount').textContent = `${filtered.length} / ${state.topics.length} kayıt`;
        renderGrid();
      }

      function getFilteredTopics() {
        const query = norm($('searchInput').value);
        const statusFilter = $('statusFilter').value;
        const serviceFilter = $('serviceFilter').value;
        const priorityFilter = $('priorityFilter').value;
        return state.topics.filter(topic => {
          const searchable = norm([topic.topic, topic.owner, topic.service, topic.topicType, topic.status, topic.priority, topic.closingDate, topic.current, ...topic.updates.map(update => update.note)].join(' '));
          const priority = priorityValue(topic.priority);
          return matchesQuickFilter(topic) && (!query || searchable.includes(query)) &&
            (state.activeSheet === 'all' || topic.sheet === state.activeSheet) &&
            (!statusFilter || topic.status === statusFilter) &&
            (!priorityFilter || (priorityFilter === 'none' ? !priority : priority === priorityFilter)) &&
            (!serviceFilter || parseServiceTags(topic.service).some(service => norm(service) === norm(serviceFilter)));
        }).sort((a, b) => a.topic.localeCompare(b.topic, 'tr'));
      }

      function clearForm() {
        $('topicDrawer').close();
        form.reset();
        $('topicId').value = '';
        updateFormBadgeColors();
        serviceTags = [];
        renderServiceTags();
        $('serviceTagInput').value = '';
        $('topicSheet').value = state.activeSheet !== 'all' ? state.activeSheet : state.sheets[0];
        $('formTitle').textContent = 'Yeni konu ekle';
        $('saveTopicBtn').textContent = 'Konuyu kaydet';
        $('cancelEditBtn').classList.add('hidden');
        form.dataset.dirty = 'false';
      }

      function editTopic(id) {
        const topic = state.topics.find(item => item.id === id);
        if (!topic) return;
        $('topicId').value = topic.id;
        $('topicSheet').value = topic.sheet;
        $('topic').value = topic.topic;
        serviceTags = parseServiceTags(topic.service);
        renderServiceTags();
        $('serviceTagInput').value = '';
        $('owner').value = topic.owner || '';
        $('topicType').value = topic.topicType;
        $('priority').value = topic.priority;
        $('status').value = topic.status;
        updateFormBadgeColors();
        const calendarDate = calendarDateValue(topic.closingDate);
        $('closingDate').value = calendarDate;
        $('closingDateNote').value = calendarDate ? '' : topic.closingDate;
        $('current').value = latestUpdate(topic)?.note || topic.current;
        $('formTitle').textContent = 'Konuyu düzenle';
        $('saveTopicBtn').textContent = 'Değişiklikleri kaydet';
        $('cancelEditBtn').classList.remove('hidden');
        form.dataset.dirty = 'false';
        if (!$('topicDrawer').open) $('topicDrawer').showModal();
        $('topic').focus();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }

      function openWeeklyUpdate(id) {
        if (gridDrafts.size) return announce('Önce tablodaki değişiklikleri kaydedin veya geri alın.', 'error');
        const topic = state.topics.find(item => item.id === id);
        if (!topic) return;
        const today = localDate();
        $('weeklyDialog').dataset.topicId = topic.id;
        $('weeklyDialog').dataset.date = today;
        $('weeklyTopicTitle').textContent = topic.topic;
        $('weeklyWeekRange').value = weekRangeLabel(today);
        $('weeklyExactDate').value = updateDateLabel(today);
        $('weeklyNote').value = '';
        $('weeklyDialog').showModal();
        $('weeklyNote').focus();
      }

      $('weeklyForm').addEventListener('submit', async event => {
        event.preventDefault();
        const dialog = $('weeklyDialog');
        const today = localDate();
        if (dialog.dataset.date !== today) {
          dialog.dataset.date = today;
          $('weeklyWeekRange').value = weekRangeLabel(today);
          $('weeklyExactDate').value = updateDateLabel(today);
          announce('Tarih değişti; güncel haftayı kontrol edip yeniden kaydedin.', 'info');
          return;
        }
        const topic = state.topics.find(item => item.id === dialog.dataset.topicId);
        const note = $('weeklyNote').value.trim();
        if (!topic || !note) return;
        const updated = {
          ...topic,
          current: note,
          updates: [...topic.updates, { id: crypto.randomUUID(), date: today, note }]
        };
        const topics = state.topics.map(item => item.id === topic.id ? updated : item);
        const button = $('saveWeeklyBtn');
        button.disabled = true;
        try {
          if (await persist(topics, state.sheets)) {
            dialog.close();
            render();
            announceSaved(`Haftalık güncelleme eklendi: ${weekRangeLabel(today)}. Eklenme tarihi: ${updateDateLabel(today)}.`);
          }
        } finally {
          button.disabled = false;
        }
      });
      $('cancelWeeklyBtn').addEventListener('click', () => $('weeklyDialog').close());

      form.addEventListener('submit', async event => {
        event.preventDefault();
        const id = $('topicId').value;
        const old = state.topics.find(item => item.id === id);
        const updates = old ? [...old.updates] : [];
        const currentInput = $('current').value.trim();
        const previousCurrent = old ? (latestUpdate(old)?.note || old.current) : '';
        if (currentInput && currentInput !== previousCurrent) {
          updates.push({ id: crypto.randomUUID(), date: localDate(), note: currentInput });
        }
        const latestNote = orderedUpdates(updates).at(-1)?.note || '';
        const topic = {
          id: old?.id || crypto.randomUUID(),
          sheet: $('topicSheet').value,
          topic: $('topic').value.trim(),
          service: serviceTags.join(', '),
          owner: $('owner').value.trim(),
          topicType: $('topicType').value.trim(),
          priority: $('priority').value,
          status: $('status').value,
          closingDate: $('closingDate').value || $('closingDateNote').value.trim(),
          current: latestNote || currentInput,
          updates
        };
        const topics = old
          ? state.topics.map(item => item.id === id ? topic : item)
          : [...state.topics, topic];
        const button = $('saveTopicBtn');
        button.disabled = true;
        try {
          if (await persist(topics, state.sheets)) {
            clearForm();
            render();
            announceSaved(old ? 'Konu güncellendi.' : 'Konu kaydedildi.');
          }
        } finally {
          button.disabled = false;
        }
      });

      $('cancelEditBtn').addEventListener('click', clearForm);
      $('resetFormBtn').addEventListener('click', () => { if(form.dataset.dirty !== 'true' || confirm('Formdaki kaydedilmemiş bilgiler temizlensin mi?')) clearForm(); });
      $('searchInput').addEventListener('input', render);
      $('priority').addEventListener('change', updateFormBadgeColors);
      $('status').addEventListener('change', updateFormBadgeColors);
      $('closingDate').addEventListener('change', () => {
        if ($('closingDate').value) $('closingDateNote').value = '';
        form.dataset.dirty = 'true';
      });
      $('closingDateNote').addEventListener('input', () => {
        if ($('closingDateNote').value.trim()) $('closingDate').value = '';
      });
      $('statusFilter').addEventListener('change', render);
      $('priorityFilter').addEventListener('change', render);
      $('serviceFilter').addEventListener('change', render);
      $('clearFiltersBtn').addEventListener('click', () => {
        quickFilter = 'all';
        document.querySelectorAll('[data-quick]').forEach(b=>b.classList.toggle('active',b.dataset.quick==='all'));
        state.activeSheet = 'all';
        $('searchInput').value = '';
        $('statusFilter').value = '';
        $('priorityFilter').value = '';
        $('serviceFilter').value = '';
        render();
      });
      form.addEventListener('input', () => { form.dataset.dirty = 'true'; });
      $('serviceTagInput').addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ',') {
          event.preventDefault();
          commitServiceEntry();
          form.dataset.dirty = 'true';
        }
      });
      $('serviceTagInput').addEventListener('change', () => {
        commitServiceEntry();
        form.dataset.dirty = 'true';
      });
      $('serviceTagInput').addEventListener('blur', commitServiceEntry);
      $('serviceTags').addEventListener('click', event => {
        const removeButton = event.target.closest('[data-remove-service]');
        if (!removeButton) return;
        serviceTags.splice(Number(removeButton.dataset.removeService), 1);
        renderServiceTags();
        form.dataset.dirty = 'true';
      });
      $('topicSheet').addEventListener('change', () => {
        state.activeSheet = $('topicSheet').value;
        render();
      });
      $('sheetBar').addEventListener('click', async event => {
        if (event.target.id === 'newSheetBtn') {
          $('newSheetName').value = '';
          $('sheetDialog').showModal();
          $('newSheetName').focus();
          return;
        }
        const tab = event.target.closest('[data-sheet]');
        if (!tab) return;
        state.activeSheet = tab.dataset.sheet;
        render();
      });
      $('cancelSheetBtn').addEventListener('click', () => $('sheetDialog').close());
      $('sheetForm').addEventListener('submit', async event => {
        event.preventDefault();
        const name = $('newSheetName').value.trim();
        if (!name || name.length > 31 || /[\\/:*?\[\]]/.test(name)) {
          announce('Sayfa adı boş olamaz ve \\/:*?[] karakterlerini içeremez.', 'error');
          return;
        }
        if (state.sheets.some(sheet => norm(sheet) === norm(name))) {
          announce('Bu adla bir sayfa zaten var.', 'error');
          return;
        }
        if (state.sheets.length >= 200) {
          announce('En fazla 200 sayfa oluşturabilirsiniz.', 'error');
          return;
        }
        if (await persist(state.topics, [...state.sheets, name])) {
          state.activeSheet = name;
          $('sheetDialog').close();
          clearForm();
          render();
          $('topic').focus();
          announceSaved(`"${name}" sayfası oluşturuldu.`);
        }
      });
      $('importExcelBtn').addEventListener('click', () => $('excelFile').click());
      $('restoreBtn').addEventListener('click', () => $('jsonFile').click());
      $('exportExcelBtn').addEventListener('click', exportExcel);
      $('htmlReportBtn').addEventListener('click', openHtmlReport);
      $('backupBtn').addEventListener('click', downloadBackup);

      function normalizeHeader(header) {
        return norm(header).replace(/[^a-z0-9]/g, '');
      }
      function excelColumns(row) {
        const headers=row.map(normalizeHeader), used=new Set();
        const take=predicate=>{const index=headers.findIndex((header,i)=>!used.has(i)&&predicate(header));if(index>=0)used.add(index);return index;};
        const indices={};
        indices.service=take(h=>(h.includes('etkilenen')&&h.includes('servis'))||['servis','service'].includes(h));
        indices.topicType=take(h=>(h.includes('konu')&&h.includes('tip'))||h==='topictype');
        indices.closingDate=take(h=>(h.includes('planlanan')&&h.includes('kapan'))||h.includes('kapanistarihi')||h==='closingdate');
        indices.current=take(h=>h.includes('guncel')||h.includes('current'));
        indices.status=take(h=>h.includes('durum')||h==='status');
        indices.priority=take(h=>h.includes('onem')||h.includes('oncelik')||h==='priority');
        indices.owner=take(h=>h==='sorumlu'||h==='sorumlukisi'||h==='owner');
        indices.topic=take(h=>h.includes('konu')||h==='topic'||h==='baslik');
        return {indices,used,score:used.size};
      }
      function excelDateText(value) {
        if(value instanceof Date&&!Number.isNaN(value.getTime())) return `${value.getFullYear()}-${String(value.getMonth()+1).padStart(2,'0')}-${String(value.getDate()).padStart(2,'0')}`;
        if(typeof value==='number') {
          const parsed=XLSX.SSF.parse_date_code(value);
          if(parsed)return `${parsed.y}-${String(parsed.m).padStart(2,'0')}-${String(parsed.d).padStart(2,'0')}`;
        }
        const text=String(value??'').trim();
        const match=text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
        return match?`${match[3]}-${match[2].padStart(2,'0')}-${match[1].padStart(2,'0')}`:text;
      }
      function readExcelRows(rows, sheetName) {
        if(rows.length<2||!rows.some(row=>row.some(cell=>String(cell??'').trim()))) return [];
        let headerIndex=-1, mapping=null;
        rows.slice(0,30).forEach((row,i)=>{
          const candidate=excelColumns(row);
          if(candidate.indices.topic>=0&&(!mapping||candidate.score>mapping.score)){mapping=candidate;headerIndex=i;}
        });
        if(!mapping)throw new Error(`"${sheetName}" sayfasında Konu/Başlık sütunu bulunamadı. Veri değiştirilmedi.`);
        const {indices,used}=mapping;
        const weeklyColumns=rows[headerIndex].map((header,index)=>({header,index})).filter(column=>!used.has(column.index));
        const text=(row,index)=>index>=0?String(row[index]??'').trim():'';
        return rows.slice(headerIndex+1).filter(row=>text(row,indices.topic)).map(row=>({
          id:crypto.randomUUID(),sheet:sheetName,
          topic:text(row,indices.topic),service:text(row,indices.service),owner:text(row,indices.owner),
          topicType:text(row,indices.topicType),priority:priorityValue(text(row,indices.priority)),
          status:normalizeStatus(text(row,indices.status)),closingDate:excelDateText(indices.closingDate>=0?row[indices.closingDate]:''),
          current:text(row,indices.current),
          updates:weeklyColumns.map(column=>({id:crypto.randomUUID(),date:column.header instanceof Date?excelDateText(column.header):String(column.header??''),note:text(row,column.index)})).filter(update=>update.note)
        }));
      }

      $('excelFile').addEventListener('change', event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        if (!window.XLSX) return announce('Excel kütüphanesi yüklenemedi. İnternet bağlantısını kontrol edin.', 'error');
        const reader = new FileReader();
        reader.onerror = () => announce('Excel dosyası okunamadı.', 'error');
        reader.onload = async loadEvent => {
          try {
            const workbook = XLSX.read(new Uint8Array(loadEvent.target.result), { type: 'array', cellDates: true });
            const imported = workbook.SheetNames.flatMap(sheetName =>
              readExcelRows(XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1, defval: '' }), sheetName)
            );
            const importedSheets = workbook.SheetNames.filter(name=>imported.some(topic=>topic.sheet===name));
            if (!importedSheets.length || !imported.length) throw new Error('Aktarılabilecek konu bulunamadı. Mevcut veriler değiştirilmedi.');
            const importedKeys = new Set(importedSheets);
            const replacedCount = state.topics.filter(topic => importedKeys.has(topic.sheet)).length;
            if (!window.confirm(`${importedSheets.length} Excel sayfası ve ${imported.length} konu bulundu. Aynı adlı mevcut sayfaların içeriği Excel verisiyle değiştirilecek (${replacedCount} konu); diğer sayfalar korunacak. Devam edilsin mi?`)) return;
            const topics = [
              ...state.topics.filter(topic => !importedKeys.has(topic.sheet)),
              ...imported
            ];
            const sheets = uniqueNames([...state.sheets.filter(sheet => !importedKeys.has(sheet)), ...importedSheets]);
            if (await persist(topics, sheets)) {
              state.activeSheet = importedSheets[0];
              render();
              announce(`${importedSheets.length} Excel sayfası ve ${imported.length} konu içe aktarıldı.`, 'success');
            }
          } catch (error) {
            announce(`Excel içe aktarılamadı: ${error.message}`, 'error');
          }
        };
        reader.readAsArrayBuffer(file);
      });

      function exportExcel() {
        if (!state.sheets.length) return announce('Dışa aktarılacak sayfa bulunmuyor.', 'error');
        if (!window.XLSX) return announce('Excel kütüphanesi yüklenemedi. İnternet bağlantısını kontrol edin.', 'error');
        try {
          const workbook = buildWorkbook();
          XLSX.writeFile(workbook, `haftalik-rapor-v3-${localDate()}.xlsx`);
          announce('Excel dosyası indirilmeye hazır.', 'success');
        } catch (error) {
          announce(`Excel çıktısı oluşturulamadı: ${error.message}`, 'error');
        }
      }

      function weeklyLabel(update) {
        if (!update.date) return 'Haftalık Güncelleme';
        return weekRangeLabel(update.date) || update.date;
      }

      function weeklyNotes(topic) {
        const notes = new Map();
        topic.updates.forEach(update => {
          const label = weeklyLabel(update);
          const note = `${updateDateLabel(update.date)}: ${update.note}`;
          notes.set(label, [...(notes.get(label) || []), note].filter(Boolean).join('\n\n'));
        });
        return notes;
      }

      function buildWorkbook() {
        const workbook = XLSX.utils.book_new();
        state.sheets.forEach(sheet => {
          const sheetTopics = state.topics.filter(topic => topic.sheet === sheet);
          const labels = orderedWeeklyLabels(sheetTopics.flatMap(topic => topic.updates.map(weeklyLabel)));
          const matrix = [[
            'Konu', 'Etkilenen Servis', 'Konu Tipi', 'Planlanan Kapanış Tarihi',
            'Önem', 'Durum', 'Güncel Durum (Son Hafta)', ...labels
          ]];
          sheetTopics.forEach(topic => {
            const notes = weeklyNotes(topic);
            matrix.push([
              topic.topic, topic.service, topic.topicType, formatDate(topic.closingDate),
              topic.priority, topic.status, topic.current,
              ...labels.map(label => notes.get(label) || '')
            ]);
          });
          XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix), sheet.slice(0, 31));
        });
        return workbook;
      }

      function openHtmlReport() {
        if(gridDrafts.size||state.saving||uncertainWrite)return announce('Rapor için önce kaydı tamamlayın.','info');
        const selectedTopics = getFilteredTopics();
        if (!selectedTopics.length) return announce('Seçili filtrelerde yönetici raporuna girecek konu yok.', 'error');
        const selectedSheets = state.sheets.filter(name => selectedTopics.some(topic => topic.sheet === name));
        const sheets = selectedSheets.map(name => {
          const topics = selectedTopics.filter(topic => topic.sheet === name);
          const labels = orderedWeeklyLabels(topics.flatMap(topic => topic.updates.map(weeklyLabel)));
          const data = [[
            'Konu', 'Etkilenen Servis', 'Konu Tipi', 'Planlanan Kapanış Tarihi',
            'Önem', 'Durum', 'Güncel Durum (Son Hafta)', ...labels
          ]];
          topics.forEach(topic => {
            const notes = weeklyNotes(topic);
            data.push([
              topic.topic, topic.service, topic.topicType, formatDate(topic.closingDate),
              topic.priority, topic.status, topic.current, ...labels.map(label => notes.get(label) || '')
            ]);
          });
          return { name, data };
        });
        const reportUrl = new URL('./report.html?from=v25', location.href);
        const reportWindow = window.open(reportUrl.href, '_blank');
        const onReady=event=>{
          if(event.source===reportWindow&&event.data?.type==='istakip-report-ready'){
            reportWindow.postMessage({type:'istakip-report-data',payload:{sheets}},location.protocol==='file:'?'*':location.origin);
            window.removeEventListener('message',onReady);
          }
        };
        window.addEventListener('message',onReady);
        setTimeout(()=>window.removeEventListener('message',onReady),60000);

        if (!reportWindow) {
          announce('Tarayıcı yeni sekmeyi engelledi. Açılır pencere izni verip tekrar deneyin.', 'error');
          return;
        }
        announce(`${selectedTopics.length} konu için v2.5 yönetici raporu hazırlanıyor.`, 'success');
      }

      function downloadBackup() {
        const backup = { version: 1, exportedAt: new Date().toISOString(), sheets: state.sheets, topics: state.topics };
        const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `is-takip-v2.5-yedek-${localDate()}.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }

      $('jsonFile').addEventListener('change', event => {
        const file = event.target.files?.[0];
        event.target.value = '';
        if (!file) return;
        const reader = new FileReader();
        reader.onerror = () => announce('JSON yedek dosyası okunamadı.', 'error');
        reader.onload = async loadEvent => {
          try {
            const restored = validateData(JSON.parse(loadEvent.target.result));
            if (!window.confirm(`${restored.sheets.length} sayfa ve ${restored.topics.length} konu yüklenecek; mevcut kayıtlar değiştirilecek. Devam edilsin mi?`)) return;
            if (await persist(restored.topics, restored.sheets)) {
              state.activeSheet = 'all';
              render();
              announceSaved('Yedek geri yüklendi.');
            }
          } catch (error) {
            announce(`Yedek yüklenemedi: ${error.message}`, 'error');
          }
        };
        reader.readAsText(file);
      });

      const gridDrafts = new Map();
      const expandedHistory = new Set();
      let gridSaving = false;
      let autosaveTimer, saveFailed = false, quickFilter = 'all';
      let uncertainWrite=null;
      function lockUncertainUI() {
        document.querySelector('.layout').inert=Boolean(uncertainWrite)||!storage;
        $('checkCommit').hidden=!uncertainWrite;
        if(uncertainWrite) announce('Kayıt sonucu henüz doğrulanamadı. Taslağınız ekranda korunuyor; İşlem sonucunu denetle düğmesine basın.','error');
      }
      const checkCommit=document.createElement('button');checkCommit.id='checkCommit';checkCommit.className='button primary';checkCommit.hidden=true;checkCommit.textContent='İşlem sonucunu denetle';
      document.querySelector('.workbar').append(checkCommit);
      checkCommit.onclick=async()=>{
        if(!uncertainWrite||!storage)return;
        checkCommit.disabled=true;
        try{
          const receipt=await storage.receipt(uncertainWrite.operationId);
          if(receipt.committed){
            const remote=await storage.read();acceptSnapshot(remote);
            if(uncertainWrite.grid)gridDrafts.clear();else {clearForm();$('quickAdd').reset();$('weeklyDialog').close();}
            uncertainWrite=null;saveFailed=false;render();announce('Kayıt doğrulandı.','success');
          }else{uncertainWrite=null;announce('İşlem bulunamadı. Taslağınız korunuyor; yeniden kaydedebilirsiniz.','info');}
          lockUncertainUI();gridStatus();
        }catch(error){announce(error.message,'error');}
        finally{checkCommit.disabled=false;}
      };
      const columns = [
        ['topic','Konu',240], ['service','Etkilenen servisler',160], ['topicType','Proje / Talep',100],
        ['closingDate','Proje kapanış tarihi',10], ['owner','Sorumlu',160],
        ['priority','Önem',1], ['status','Durum',20], ['current','Güncel durum / sonraki adım',2000]
      ];
      function gridValue(topic, field) {
        const draft=gridDrafts.get(topic.id);
        if(draft?.[field]!==undefined) return draft[field];
        if(field==='current') return latestUpdate(topic)?.note || topic[field] || '';
        return topic[field] ?? '';
      }
      function renderGrid() {
        const filtered = getFilteredTopics();
        $('gridWrap').classList.toggle('hidden', filtered.length === 0);
        $('emptyState').classList.toggle('hidden', filtered.length > 0);
        [...$('gridWrap').querySelectorAll('details[data-history-id][open]')].forEach(details => expandedHistory.add(details.dataset.historyId));
        const header='<thead><tr><th></th><th>#</th>'+columns.map(column=>`<th>${column[1]}</th>`).join('')+'<th>Haftalık geçmiş</th><th>İşlem</th></tr></thead>';
        const rows=filtered.map((topic,rowIndex)=>{
          const draft=gridDrafts.get(topic.id)||{};
          const latest=latestUpdate(topic);
          const updates=orderedUpdates(topic.updates).reverse();
          const contextValue=value=>escapeHtml(value||'Belirtilmedi');
          const closingValue=topic.closingDate?updateDateLabel(topic.closingDate):'Belirtilmedi';
          const history=updates.length
            ? `<details class="history combined-history" data-history-id="${escapeHtml(topic.id)}" ${expandedHistory.has(topic.id)?'open':''}><summary>${updates.length} kayıt · Son: ${escapeHtml(weeklyLabel(latest))}</summary><div class="history-context"><div class="history-context-row"><span class="history-context-label">Etkilenen servisler</span><span>${contextValue(parseServiceTags(topic.service).join(', '))}</span></div><div class="history-context-row"><span class="history-context-label">Proje / Talep</span><span>${contextValue(topic.topicType)}</span></div><div class="history-context-row"><span class="history-context-label">Planlanan kapanış</span><span>${escapeHtml(closingValue)}</span></div></div><ol class="history-list">${updates.map(item=>`<li><span class="history-date">${escapeHtml(weeklyLabel(item))}</span><span class="history-entry-date">Eklenme tarihi: ${escapeHtml(updateDateLabel(item.date))}</span>${escapeHtml(item.note)}</li>`).join('')}</ol></details>`
            : '<span class="topic-meta">Henüz haftalık not yok</span>';
          const cells=columns.map(([field,label,max],columnIndex)=>{
            const rawValue=gridValue(topic,field);
            const value=field==='closingDate'?calendarDateValue(rawValue):rawValue;
            const attrs=`data-id="${escapeHtml(topic.id)}" data-field="${field}" data-row="${rowIndex}" data-col="${columnIndex}" aria-label="${escapeHtml(topic.topic)}: ${label}"`;
            const choices=field==='priority'?['','1','2','3','4','5']:field==='status'?['Aktif','Askıda','Kapandı']:null;
            const selectClass=field==='priority'?` class="grid-priority priority level-${escapeHtml(priorityValue(value)||'0')}"`:field==='status'?` class="grid-status status ${statusKind(value)}"`:'';
            const input=choices
              ? `<select${selectClass} ${attrs}>${choices.map(choice=>`<option value="${choice}" ${choice===value?'selected':''}>${choice||'—'}</option>`).join('')}</select>`
              : `<input ${attrs} type="${field==='closingDate'?'date':'text'}" maxlength="${max}" value="${escapeHtml(value)}"${field==='service'?' placeholder="Virgülle ayırın"':''}>${field==='closingDate'&&rawValue&&!value?`<span class="legacy-closing-note">${escapeHtml(rawValue)}</span>`:''}`;
            return `<td class="${draft[field]!==undefined?'changed':''}">${input}</td>`;
          }).join('');
          return `<tr><td><button class="button small weekly-add" type="button" data-weekly-add="${escapeHtml(topic.id)}" aria-label="${escapeHtml(topic.topic)} için haftalık güncelleme ekle" title="Haftalık güncelleme ekle">+</button></td><td>${rowIndex+1}</td>${cells}<td>${history}</td><td><div class="row-actions"><button class="button small" type="button" data-edit="${escapeHtml(topic.id)}">Düzenle</button><button class="button small danger" type="button" data-delete="${escapeHtml(topic.id)}" aria-label="${escapeHtml(topic.topic)} konusunu sil">Sil</button></div></td></tr>`;
        }).join('');
        $('gridWrap').innerHTML=`<table aria-label="Birleşik konu ve haftalık geçmiş tablosu">${header}<tbody>${rows}</tbody></table>`;
        gridStatus();
        const open=state.topics.filter(t=>t.status!=='Kapandı');
        const late=open.filter(t=>/^\d{4}-\d{2}-\d{2}$/.test(t.closingDate)&&t.closingDate<localDate()).length;
        const high=open.filter(t=>Number(t.priority)>=4).length;
        const unassigned=open.filter(t=>!t.owner?.trim()).length;
        $('insights').innerHTML=`<span><b>${late}</b> Hedef tarihi geçen açık konu</span><span><b>${high}</b> Yüksek öncelikli açık konu</span><span><b>${unassigned}</b> Sorumlusu eksik açık konu</span><span>Göstergeler kaydedilmiş tüm konuları kapsar.</span>`;
      }
      function gridStatus() {
        $('gridStatus').textContent=gridSaving?'Kaydediliyor…':uncertainWrite?'Kayıt sonucu denetlenmeli':gridDrafts.size?(saveFailed?'Kaydedilemedi · taslak korunuyor · Şimdi kaydet ile yeniden deneyin':`${gridDrafts.size} satır değişti · hücreden çıkınca otomatik kaydedilir`):'✓ Tüm değişiklikler kaydedildi';
        $('saveGrid').disabled=!gridDrafts.size||gridSaving;
        $('discardGrid').disabled=!gridDrafts.size||gridSaving;
      }
      function changeCell(input, value) {
        const original=state.topics.find(t=>t.id===input.dataset.id);
        if (!original) return;
        const field=input.dataset.field;
        const draft={...(gridDrafts.get(original.id)||{})};
        const originalValue=field==='current'?(latestUpdate(original)?.note||original.current||''):(original[field]||'');
        if (value===originalValue) delete draft[field]; else draft[field]=value;
        if (Object.keys(draft).length) gridDrafts.set(original.id,draft); else gridDrafts.delete(original.id);
        if(field==='priority')input.className=`grid-priority priority level-${priorityValue(value)||'0'}`;
        if(field==='status')input.className=`grid-status status ${statusKind(value)}`;
        input.closest('td').classList.toggle('changed',draft[field]!==undefined);
        gridStatus();
      }
      $('gridWrap').addEventListener('input',event=>{ if(event.target.dataset.field) changeCell(event.target,event.target.value); });
      $('gridWrap').addEventListener('toggle',event=>{
        const details=event.target;
        if(details.matches('details[data-history-id]')) {
          if(details.open)expandedHistory.add(details.dataset.historyId);
          else expandedHistory.delete(details.dataset.historyId);
        }
      },true);
      $('gridWrap').addEventListener('click',async event=>{
        const weeklyButton=event.target.closest('[data-weekly-add]');
        if(weeklyButton)return openWeeklyUpdate(weeklyButton.dataset.weeklyAdd);
        const editButton=event.target.closest('[data-edit]');
        if(editButton) {
          if(gridDrafts.size)return announce('Önce tablodaki değişiklikleri kaydedin veya geri alın.','error');
          if(form.dataset.dirty==='true')return announce('Önce formdaki değişiklikleri kaydedin veya Vazgeç ile kapatın.','error');
          return editTopic(editButton.dataset.edit);
        }
        const deleteButton=event.target.closest('[data-delete]');
        if(!deleteButton)return;
        if(gridDrafts.size)return announce('Önce tablodaki değişiklikleri kaydedin veya geri alın.','error');
        if(form.dataset.dirty==='true')return announce('Önce formdaki değişiklikleri kaydedin veya Vazgeç ile kapatın.','error');
        const topic=state.topics.find(item=>item.id===deleteButton.dataset.delete);
        if(!topic||!window.confirm(`"${topic.topic}" konusu silinsin mi?`))return;
        const topics=state.topics.filter(item=>item.id!==topic.id);
        if(await persist(topics,state.sheets)){render();announceSaved('Konu silindi.');}
      });
      $('gridWrap').addEventListener('paste',event=>{
        const target=event.target;
        if(!target.dataset.field) return;
        const text=event.clipboardData.getData('text/plain');
        if(!/[\t\r\n]/.test(text)) return;
        event.preventDefault();
        const matrix=text.replace(/\r/g,'').replace(/\n$/,'').split('\n').map(row=>row.split('\t'));
        const visibleColumns=columns.map((_,i)=>i).filter(i=>!$('gridWrap').classList.contains('compact-columns')||![1,2].includes(i));
        const startRow=Number(target.dataset.row), startCol=visibleColumns.indexOf(Number(target.dataset.col)), edits=[];
        // Validate the whole paste before touching any draft cell.
        for(let r=0;r<matrix.length;r++) for(let c=0;c<matrix[r].length;c++) {
          const column=visibleColumns[startCol+c];
          const input=$('gridWrap').querySelector(`[data-row="${startRow+r}"][data-col="${column}"]`);
          if(!input) return announce('Yapıştırma görünür tablo sınırını aşıyor. Hiçbir hücre değiştirilmedi.','error');
          let value=matrix[r][c].trim();
          const field=input.dataset.field, max=columns[column][2];
          if(field==='closingDate' && /^\d{2}\.\d{2}\.\d{4}$/.test(value)) value=value.split('.').reverse().join('-');
          if(value.length>max || (field==='topic'&&!value) || (field==='closingDate'&&value&&!calendarDateValue(value)) || (field==='priority'&&!['','1','2','3','4','5'].includes(value)) || (field==='status'&&!['Aktif','Askıda','Kapandı'].includes(value))) return announce(`Yapıştırmada geçersiz ${columns[column][1]}. Hiçbir hücre değiştirilmedi.`,'error');
          edits.push([input,value]);
        }
        edits.forEach(([input,value])=>{input.value=value;changeCell(input,value)});
        announce(`${edits.length} hücre taslağa alındı. Hücreden çıkınca otomatik kaydedilecek.`);
      });
      $('discardGrid').onclick=()=>{ if(confirm('Kaydedilmemiş tablo değişiklikleri geri alınsın mı?')) {gridDrafts.clear();renderGrid();} };
      $('saveGrid').onclick=saveGrid;
      async function saveGrid(){
        clearTimeout(autosaveTimer);
        if(!gridDrafts.size||gridSaving||state.saving||uncertainWrite)return;
        const focused=document.activeElement;
        const focusId=focused?.dataset.id, focusField=focused?.dataset.field;
        const caret=focused?.selectionStart;
        if(form.dataset.dirty==='true') return announce('Önce soldaki formu tamamlayın veya Vazgeç ile kapatın.','error');
        const topics=state.topics.map(t=>{
          const draft=gridDrafts.get(t.id);
          if(!draft) return t;
          const result={...t,...draft,updates:[...t.updates]};
          // One entry from the user's actual update; no invented weekly activity.
          if(draft.current && draft.current!==(latestUpdate(t)?.note||t.current)) result.updates.push({id:crypto.randomUUID(),date:localDate(),note:draft.current});
          result.current=latestUpdate(result)?.note || result.current;
          return result;
        });
        if(topics.some(t=>!t.topic.trim())) return announce('Konu boş bırakılamaz.','error');
        gridSaving=true;gridStatus();
        $('gridWrap').inert=true;
        try {
          if(await persist(topics,state.sheets)) {gridDrafts.clear();saveFailed=false;render();}
          else saveFailed=true;
        } finally {
          gridSaving=false;$('gridWrap').inert=false;gridStatus();
          if(focusId && (document.activeElement===document.body || document.activeElement===focused)) {
            const next=[...$('gridWrap').querySelectorAll('[data-field]')].find(n=>n.dataset.id===focusId&&n.dataset.field===focusField);
            if(next){next.focus();if(caret!==null&&next.type==='text')next.setSelectionRange(caret,caret);}
          }
        }
      };
      function scheduleSave(){
        clearTimeout(autosaveTimer);
        if(!saveFailed)autosaveTimer=setTimeout(saveGrid,700);
      }
      $('gridWrap').addEventListener('change',scheduleSave);
      $('gridWrap').addEventListener('focusout',scheduleSave);
      $('gridWrap').addEventListener('keydown',event=>{
        if(event.key==='Enter'&&event.target.dataset.field){event.preventDefault();event.target.blur();scheduleSave();}
      });
      $('newTopicBtn').onclick=()=>{
        if(gridDrafts.size)return announce('Tablo kaydı tamamlandıktan sonra yeni konu açabilirsiniz.','info');
        clearForm();$('topicDrawer').showModal();$('topic').focus();
      };
      function closeDrawer(event){
        if(form.dataset.dirty==='true'&&!confirm('Kaydedilmemiş form değişikliklerinden vazgeçilsin mi?')){event?.preventDefault();return;}
        clearForm();
      }
      $('closeDrawer').onclick=closeDrawer;
      $('topicDrawer').addEventListener('cancel',closeDrawer);
      $('quickAdd').onsubmit=async event=>{
        event.preventDefault();
        if(gridDrafts.size||state.saving||uncertainWrite)return announce('Önce devam eden tablo kaydını tamamlayın.','info');
        const name=$('quickTopic').value.trim();if(!name)return;
        const button=$('quickAdd').querySelector('button');button.disabled=true;
        try{
          const topic={id:crypto.randomUUID(),sheet:state.activeSheet==='all'?state.sheets[0]:state.activeSheet,topic:name,owner:$('quickOwner').value.trim(),service:'',topicType:'',priority:'',status:'Aktif',closingDate:'',current:'',updates:[]};
          if(await persist([...state.topics,topic],state.sheets)){$('quickAdd').reset();render();announceSaved('Konu eklendi.');}
        }finally{button.disabled=false;}
      };
      function matchesQuickFilter(topic){
        if(quickFilter==='all')return true;
        if(topic.status==='Kapandı')return false;
        const today=localDate(),closing=calendarDateValue(topic.closingDate);
        if(quickFilter==='high')return Number(topic.priority)>=4;
        if(quickFilter==='unassigned')return !topic.owner?.trim();
        if(quickFilter==='late')return closing&&closing<today;
        if(quickFilter==='weekly')return !topic.updates.some(u=>weekRangeLabel(u.date)===weekRangeLabel(today));
        const end=new Date(today+'T12:00:00');end.setDate(end.getDate()+7);
        const limit=end.getFullYear()+'-'+String(end.getMonth()+1).padStart(2,'0')+'-'+String(end.getDate()).padStart(2,'0');
        return closing&&closing>=today&&closing<=limit;
      }
      $('quickFilters').onclick=event=>{
        const button=event.target.closest('[data-quick]');if(!button)return;
        quickFilter=button.dataset.quick;
        document.querySelectorAll('[data-quick]').forEach(b=>b.classList.toggle('active',b===button));render();
      };
      $('toggleColumns').onclick=()=>{
        const compact=$('gridWrap').classList.toggle('compact-columns');
        $('toggleColumns').textContent=compact?'Tüm sütunları göster':'Sade tabloya dön';
        $('toggleColumns').setAttribute('aria-pressed',String(!compact));
      };
      // A recoverable draft download is available even when the server cannot be reached.
      const draftButton=document.createElement('button');
      draftButton.className='button';draftButton.textContent='JSON taslağını indir';
      document.querySelector('.workbar').append(draftButton);
      draftButton.onclick=()=>{
        const payload={version:1,sheets:state.sheets,topics:state.topics.map(t=>({...t,...gridDrafts.get(t.id)}))};
        const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));
        const a=document.createElement('a');a.href=url;a.download='is-takip-kaydedilmemis-taslak.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      };
      window.addEventListener('beforeunload',event=>{if(gridDrafts.size||form.dataset.dirty==='true'||$('quickTopic').value.trim()||$('weeklyDialog').open&&$('weeklyNote').value.trim()||state.saving||uncertainWrite){event.preventDefault();event.returnValue='';}});
      // Read only while no editor or pending write can be overwritten.
      setInterval(async()=>{
        if(!storage||document.hidden||uncertainWrite||state.saving||gridDrafts.size||form.dataset.dirty==='true'||$('topicDrawer').open||$('weeklyDialog').open||document.activeElement?.closest('#gridWrap'))return;
        try{
          const remote=await storage.read();
          if(uncertainWrite||state.saving||gridDrafts.size||form.dataset.dirty==='true'||$('topicDrawer').open||$('weeklyDialog').open||document.activeElement?.closest('#gridWrap'))return;
          if(remote.etag!==state.remoteEtag){acceptSnapshot(remote);render();}
          state.projectStorage=true;setStorageLabel();
        }catch(error){state.projectStorage=false;setStorageLabel();}
      },3000);

      loadData();
    })();
