/* ============================================================================
 *  블로그랩 — 확장 팝업
 *  · 도우미 바 표시 on/off
 *  · 빠른 서식 추가/삭제 (chrome.storage.local, content.js와 같은 키 사용)
 *  · 네이버 글쓰기 화면 바로 열기
 * ========================================================================== */
(() => {
  'use strict';

  const KEY_TPL = 'blab_templates_v1';
  const KEY_BAR = 'blab_bar_enabled';

  const DEFAULT_TEMPLATES = [
    {
      id: 't-intro',
      name: '도입부',
      body: '안녕하세요, 오늘은 {주제} 이야기를 해보려고 합니다.\n\n저도 처음에는 잘 몰라서 이것저것 찾아봤는데, 직접 해보니 생각보다 어렵지 않았어요. 이 글에서는 제가 실제로 겪은 기준으로 정리했습니다.\n\n'
    },
    {
      id: 't-check',
      name: '체크리스트',
      body: '\n\n한 번에 다 하려면 놓치기 쉬우니, 아래 순서만 기억하세요.\n\n✔ 첫 번째 — 준비물 확인\n✔ 두 번째 — 일정과 동선 정리\n✔ 세 번째 — 예산과 마감 체크\n✔ 네 번째 — 후기 남길 사진 확보\n\n'
    },
    {
      id: 't-cta',
      name: '마무리 CTA',
      body: '\n\n여기까지 읽어주셔서 감사합니다. 궁금한 점은 댓글로 남겨주시면 확인하는 대로 답변드릴게요.\n\n이 글이 도움이 되셨다면 공감과 이웃추가 부탁드립니다. 다음 글에서는 {다음 주제}를 다뤄보겠습니다.\n'
    }
  ];

  const $ = (sel) => document.querySelector(sel);
  let templates = DEFAULT_TEMPLATES.slice();
  let toastTimer = null;

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), 1600);
  }

  function load() {
    chrome.storage.local.get([KEY_TPL, KEY_BAR], (data) => {
      if (Array.isArray(data[KEY_TPL]) && data[KEY_TPL].length) {
        templates = data[KEY_TPL];
      } else {
        chrome.storage.local.set({ [KEY_TPL]: DEFAULT_TEMPLATES });
      }
      const enabled = data[KEY_BAR] !== false;
      $('#barToggle').setAttribute('aria-pressed', String(enabled));
      render();
    });
  }

  function save() {
    chrome.storage.local.set({ [KEY_TPL]: templates });
  }

  function render() {
    const list = $('#list');
    $('#tplCount').textContent = templates.length + '개';
    if (!templates.length) {
      list.innerHTML = '<div class="empty">저장한 서식이 없습니다.<br>아래에서 첫 서식을 추가해 보세요.</div>';
      return;
    }
    list.innerHTML = '';
    templates.forEach((t) => {
      const row = document.createElement('div');
      row.className = 'row';

      const name = document.createElement('span');
      name.className = 'nm';
      name.textContent = t.name;
      name.title = t.name + '\n\n' + (t.body || '');

      const del = document.createElement('button');
      del.className = 'x';
      del.type = 'button';
      del.setAttribute('aria-label', t.name + ' 삭제');
      del.innerHTML = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      del.addEventListener('click', () => {
        templates = templates.filter(x => x.id !== t.id);
        save();
        render();
        toast('서식을 삭제했어요.');
      });

      row.append(name, del);
      list.appendChild(row);
    });
  }

  $('#addForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('#tplName').value.trim();
    const body = $('#tplBody').value;
    if (!name) { toast('이름을 입력해 주세요.'); $('#tplName').focus(); return; }
    if (!body.trim()) { toast('내용을 입력해 주세요.'); $('#tplBody').focus(); return; }
    if (templates.some(t => t.name === name)) { toast('같은 이름의 서식이 있어요.'); return; }

    templates.push({ id: 'c-' + Date.now(), name, body });
    save();
    render();
    $('#tplName').value = '';
    $('#tplBody').value = '';
    toast('서식을 추가했어요.');
  });

  $('#barToggle').addEventListener('click', () => {
    const next = $('#barToggle').getAttribute('aria-pressed') !== 'true';
    $('#barToggle').setAttribute('aria-pressed', String(next));
    chrome.storage.local.set({ [KEY_BAR]: next });
    toast(next ? '도우미 바를 켰어요.' : '도우미 바를 껐어요.');
  });

  $('#openWrite').addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://blog.naver.com/PostWriteForm.naver' });
    window.close();
  });

  load();
})();
