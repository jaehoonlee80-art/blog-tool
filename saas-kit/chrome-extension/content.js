/* ============================================================================
 *  블로그랩 — 네이버 블로그 글쓰기 도우미 (Content Script, Manifest V3)
 *
 *  동작
 *   - https://blog.naver.com/* 의 글쓰기 화면에서만 왼쪽 아래 도우미 바를 띄웁니다.
 *   - 제목 30자 제한, 공백 포함/제외 글자수, 문단 수, 읽기 시간을 실시간 계산합니다.
 *   - 자주 쓴 단어 TOP 5로 키워드 반복을 점검합니다.
 *   - 저장한 빠른 서식을 커서 위치에 한 번에 넣습니다.
 *
 *  설계 메모
 *   - 네이버 스마트에디터는 iframe 안에 들어 있어, 같은 출처일 때는 모든 프레임의
 *     document를 직접 훑어 값을 읽습니다. (all_frames: true)
 *   - iframe이 다른 출처로 격리된 경우를 대비해 postMessage 브리지를 함께 둡니다.
 *   - 화면 스타일이 네이버 CSS와 섞이지 않도록 Shadow DOM 안에서만 그립니다.
 *   - 저장 데이터는 chrome.storage.local 에만 두고 외부로 전송하지 않습니다.
 * ========================================================================== */
(() => {
  'use strict';

  const IS_TOP = window.top === window;
  const HOST_ID = 'blab-helper-host';
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

  const STOP = new Set([
    '그리고','하지만','그래서','그러면','그런데','정말','너무','아주','많이','조금','있는','있습니다',
    '있어요','합니다','했습니다','했다','위해','위한','통해','이번','오늘','여러분','저는','제가','그냥',
    '이것','그것','저것','때문','경우','때','등','수','것','및','더','잘','안','다','있다','없다','같은',
    '같이','대한','에서','으로','하고','하면','하는','되는','없는','이런','그런','저런','또','꼭','바로',
    '정도','부분','생각','같아요','해요','입니다','그러나','또한','먼저','다음','마지막','이후','이전','저도','우리'
  ]);
  const JOSA = [
    '에서는','으로는','에게는','이라고','라고는','에서','으로','에게','한테','까지','부터','보다','처럼',
    '마다','조차','밖에','이나','라도','이랑','하고','은','는','이','가','을','를','의','에','와','과','도','로','만'
  ];

  /* ---------------------------------------------------------------- storage */
  const store = {
    get(keys) {
      return new Promise(resolve => {
        try { chrome.storage.local.get(keys, resolve); }
        catch (e) { resolve({}); }
      });
    },
    set(obj) {
      return new Promise(resolve => {
        try { chrome.storage.local.set(obj, resolve); }
        catch (e) { resolve(); }
      });
    }
  };

  const onChanged = (fn) => {
    try { chrome.storage.onChanged.addListener(fn); } catch (e) { /* 확장 외부 실행 */ }
  };

  /* ------------------------------------------------------------- 텍스트 분석 */
  function cleanToken(tok) {
    let t = tok.trim();
    if (!t) return '';
    if (/^[0-9.,%]+$/.test(t)) return '';
    if (/^[a-zA-Z]$/.test(t)) return '';
    for (const j of JOSA) {
      if (t.length - j.length >= 2 && t.endsWith(j)) { t = t.slice(0, -j.length); break; }
    }
    return t;
  }

  function topWords(text, limit) {
    const raw = text.split(/[^가-힣a-zA-Z0-9]+/).filter(Boolean);
    const counts = new Map();
    let total = 0;
    raw.forEach(r => {
      const t = cleanToken(r);
      if (t.length < 2 || STOP.has(t)) return;
      total++;
      counts.set(t, (counts.get(t) || 0) + 1);
    });
    const rows = [...counts.entries()]
      .map(([w, c]) => ({ w, c, pct: total ? (c / total) * 100 : 0 }))
      .sort((a, b) => b.c - a.c || b.w.length - a.w.length)
      .slice(0, limit || 5);
    return rows;
  }

  function countStats(text) {
    const withSpace = text.length;
    const noSpace = text.replace(/\s/g, '').length;
    // 스마트에디터는 문단을 <p>로 나누므로 innerText에서 한 줄이 한 문단이 된다.
    const paragraphs = text.trim()
      ? text.trim().split(/\n+/).filter(p => p.trim().length).length
      : 0;
    const minutes = text.trim() ? Math.max(1, Math.round(noSpace / 500)) : 0;
    return { withSpace, noSpace, paragraphs, minutes };
  }

  /* --------------------------------------------------------- 에디터 DOM 탐색 */
  function isVisible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function elementText(el) {
    if (!el) return '';
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.value || '';
    return el.innerText || el.textContent || '';
  }

  const TITLE_SELECTORS = [
    'input#title',
    'textarea#title',
    '.se-title-text',
    '.se-title .se-text-paragraph',
    '.se-title [contenteditable="true"]',
    '[data-placeholder="제목"]',
    '[data-placeholder^="제목"]',
    'input[placeholder^="제목"]'
  ];

  const BODY_SELECTORS = [
    '.se-content',
    '.se-main-container',
    '.se-editor',
    '#postViewArea',
    '[data-name="SE-CONTENT"]'
  ];

  function findTitle(doc) {
    for (const sel of TITLE_SELECTORS) {
      const el = doc.querySelector(sel);
      if (isVisible(el)) return el;
    }
    return null;
  }

  function findBody(doc) {
    for (const sel of BODY_SELECTORS) {
      const el = doc.querySelector(sel);
      if (isVisible(el)) return el;
    }
    // 마지막 수단: 가장 긴 contenteditable (제목은 제외)
    const title = findTitle(doc);
    let best = null, bestLen = -1;
    doc.querySelectorAll('[contenteditable="true"]').forEach(el => {
      if (el === title || el.contains(title)) return;
      if (!isVisible(el)) return;
      const len = (el.innerText || '').length;
      if (len > bestLen) { bestLen = len; best = el; }
    });
    return best;
  }

  /** 같은 출처 프레임의 document를 모두 순회 (접근 불가 프레임은 건너뜀) */
  function eachDocument(fn) {
    const seen = new Set();
    (function walk(win, depth) {
      if (!win || depth > 4) return;
      let doc;
      try { doc = win.document; } catch (e) { return; }
      if (!doc || seen.has(doc)) return;
      seen.add(doc);
      fn(doc);
      let frames;
      try { frames = win.frames; } catch (e) { return; }
      for (let i = 0; i < frames.length; i++) {
        try { walk(frames[i], depth + 1); } catch (e) { /* cross-origin */ }
      }
    })(window, 0);
  }

  function findEditor() {
    let titleEl = null, bodyEl = null, bodyScore = -1;
    eachDocument(doc => {
      if (!titleEl) titleEl = findTitle(doc);
      const b = findBody(doc);
      if (b) {
        const score = (b.innerText || '').length + (isVisible(b) ? 1000 : 0);
        if (score > bodyScore) { bodyScore = score; bodyEl = b; }
      }
    });
    return { titleEl, bodyEl };
  }

  function readMetrics() {
    const { titleEl, bodyEl } = findEditor();
    const title = elementText(titleEl).replace(/\n/g, ' ').trim();
    const body = bodyEl ? elementText(bodyEl) : '';
    return {
      title,
      body,
      stats: countStats(body),
      words: topWords(body, 5),
      hasEditor: !!(titleEl || bodyEl)
    };
  }

  /* ------------------------------------------------------------------ 서식 삽입 */
  function insertText(editable, text) {
    if (!editable) return false;
    const doc = editable.ownerDocument;
    try { editable.focus(); } catch (e) {}
    try {
      if (doc.execCommand('insertText', false, text)) return true;
    } catch (e) { /* 폴백으로 진행 */ }
    try {
      if (editable.isContentEditable) {
        const sel = doc.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          range.insertNode(doc.createTextNode(text));
          sel.collapseToEnd();
          editable.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
          return true;
        }
      }
    } catch (e) { /* 무시 */ }
    return false;
  }

  function insertAtCursor(text) {
    const { bodyEl, titleEl } = findEditor();
    const target = bodyEl || titleEl;
    if (!target) return false;
    const editable = target.isContentEditable ? target : target.querySelector('[contenteditable="true"]');
    const ok = insertText(editable || target, text);
    if (!ok) {
      // 같은 출처 iframe 브리지로 재시도
      eachDocument(doc => {
        doc.defaultView && doc.defaultView.postMessage({ source: 'blab', type: 'insert', text }, '*');
      });
    }
    return ok;
  }

  /* ==================================================================
     iframe 쪽: 값만 상위 프레임으로 전달하고, 삽입 요청을 받아 처리
     ================================================================== */
  if (!IS_TOP) {
    const report = () => {
      const m = readMetrics();
      if (!m.hasEditor) return;
      try {
        window.top.postMessage({
          source: 'blab-frame',
          type: 'metrics',
          payload: m
        }, '*');
      } catch (e) { /* 무시 */ }
    };

    window.addEventListener('message', (e) => {
      const d = e.data;
      if (!d || d.source !== 'blab') return;
      if (d.type === 'insert') {
        const { bodyEl, titleEl } = findEditor();
        const target = bodyEl || titleEl;
        if (!target) return;
        insertText(target.isContentEditable ? target : target.querySelector('[contenteditable="true"]'), d.text);
      }
      if (d.type === 'ping') report();
    }, false);

    document.addEventListener('input', () => setTimeout(report, 300), true);
    setInterval(report, 2000);
    setTimeout(report, 800);
    return;
  }

  /* ==================================================================
     상위 프레임: 도우미 바 UI
     ================================================================== */
  let enabled = true;
  let collapsed = true;
  let templates = DEFAULT_TEMPLATES.slice();
  let latest = null;
  let frameMetrics = null;

  const host = document.createElement('div');
  host.id = HOST_ID;
  host.style.cssText = 'all:initial;position:fixed;left:16px;bottom:16px;z-index:2147483000;';
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .wrap {
        font-family: "Pretendard Variable", Pretendard, -apple-system, BlinkMacSystemFont,
                     "Apple SD Gothic Neo", "Malgun Gothic", "Noto Sans KR", sans-serif;
        font-size: 12px; line-height: 1.5; color: #E8EEF7;
        -webkit-font-smoothing: antialiased; letter-spacing: -0.01em;
      }
      .bar {
        width: 292px; background: #0E1525; border: 1px solid #263248;
        border-radius: 14px; box-shadow: 0 18px 40px -16px rgba(8,14,26,.7), 0 2px 6px rgba(8,14,26,.3);
        overflow: hidden;
      }
      .head {
        display: flex; align-items: center; gap: 8px; padding: 9px 10px 9px 11px;
        cursor: pointer; user-select: none; background: #0E1525;
      }
      .logo {
        width: 20px; height: 20px; border-radius: 6px; flex: none;
        background: linear-gradient(145deg, #05D866, #02B14F); display: grid; place-items: center;
      }
      .logo svg { display: block; }
      .brand { font-size: 11.5px; font-weight: 800; letter-spacing: -0.02em; color: #fff; }
      .summary {
        margin-left: auto; font-size: 10.5px; font-weight: 700; color: #A9B6C9;
        font-variant-numeric: tabular-nums; white-space: nowrap;
      }
      .summary.bad { color: #FF8A8E; }
      .chev { width: 18px; height: 18px; border: 0; background: transparent; color: #8FA0B8;
              display: grid; place-items: center; cursor: pointer; flex: none; padding: 0; }
      .chev svg { transition: transform .18s; }
      .bar.open .chev svg { transform: rotate(180deg); }
      .panel { display: none; padding: 0 12px 12px; border-top: 1px solid #1E2A3D; }
      .bar.open .panel { display: block; }
      .title-row { display: flex; align-items: center; gap: 6px; margin-top: 10px; }
      .title-row b { font-size: 11px; font-weight: 700; color: #A9B6C9; }
      .title-row .val { margin-left: auto; font-weight: 800; font-size: 11.5px; font-variant-numeric: tabular-nums; }
      .title-row .val.ok { color: #45E08C; }
      .title-row .val.warn { color: #FFC861; }
      .title-row .val.bad { color: #FF8A8E; }
      .meter { height: 4px; border-radius: 99px; background: #1D2739; margin-top: 6px; overflow: hidden; }
      .meter i { display: block; height: 100%; border-radius: 99px; background: linear-gradient(90deg, #2ED97F, #03C75A); transition: width .2s; }
      .meter.over i { background: linear-gradient(90deg, #FF8A8E, #E5484D); }
      .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin-top: 10px; }
      .cell { background: #151F31; border: 1px solid #1F2B3F; border-radius: 9px; padding: 7px 8px; }
      .cell .k { font-size: 9.5px; color: #8494AC; font-weight: 700; }
      .cell .v { font-size: 13px; font-weight: 800; color: #F2F6FC; font-variant-numeric: tabular-nums; margin-top: 1px; }
      .cell .v small { font-size: 9.5px; font-weight: 700; color: #8494AC; margin-left: 1px; }
      .sec { margin-top: 11px; display: flex; align-items: center; gap: 6px; }
      .sec .lab { font-size: 9.5px; font-weight: 800; color: #8494AC; letter-spacing: .02em; }
      .sec .note { margin-left: auto; font-size: 9.5px; color: #63718A; font-weight: 700; }
      .words { margin-top: 6px; display: flex; flex-direction: column; gap: 4px; }
      .word { display: flex; align-items: center; gap: 7px; }
      .word .w { width: 96px; font-size: 10.5px; font-weight: 650; color: #DCE5F2;
                 white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .word .t { flex: 1; height: 3px; border-radius: 99px; background: #1D2739; overflow: hidden; }
      .word .t i { display: block; height: 100%; border-radius: 99px; background: #2ED97F; }
      .word.hot .t i { background: #FFC861; }
      .word .c { font-size: 9.5px; color: #8494AC; font-weight: 700; width: 26px; text-align: right;
                 font-variant-numeric: tabular-nums; }
      .hint { margin-top: 8px; font-size: 9.5px; line-height: 1.5; color: #FFB4B6;
              background: #2A1A20; border: 1px solid #4A2730; border-radius: 7px; padding: 5px 7px; }
      .tpls { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; }
      .tpl {
        border: 1px solid #2A3a52; background: #16233A; color: #D6E1F0; border-radius: 7px;
        padding: 4px 8px; font-size: 10.5px; font-weight: 700; cursor: pointer;
        max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .tpl:hover { background: #1D2E4A; border-color: #3A5175; color: #fff; }
      .foot { display: flex; align-items: center; gap: 6px; margin-top: 11px;
              padding-top: 8px; border-top: 1px solid #1E2A3D; }
      .foot span { font-size: 9px; color: #5E6C84; font-weight: 650; }
      .foot button {
        margin-left: auto; border: 1px solid #2A3A52; background: transparent; color: #93A4BC;
        border-radius: 6px; padding: 3px 7px; font-size: 9.5px; font-weight: 700; cursor: pointer;
      }
      .foot button:hover { color: #fff; border-color: #3A5175; }
      .empty { color: #6C7C95; font-size: 10.5px; padding: 6px 0; }
    </style>
    <div class="wrap">
      <div class="bar" id="bar">
        <div class="head" id="head" role="button" tabindex="0" aria-label="블로그랩 도우미 열기">
          <span class="logo">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none">
              <path d="M5 18V11M12 18V5M19 18v-4" stroke="#fff" stroke-width="2.8" stroke-linecap="round"/>
            </svg>
          </span>
          <span class="brand">블로그랩</span>
          <span class="summary" id="summary">글쓰기 화면을 찾는 중…</span>
          <button class="chev" id="chev" aria-label="펼치기">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M6 15l6-6 6 6"/>
            </svg>
          </button>
        </div>
        <div class="panel">
          <div class="title-row">
            <b>제목</b>
            <span class="val" id="titleVal">0자 / 30자</span>
          </div>
          <div class="meter" id="titleMeter"><i id="titleFill" style="width:0%"></i></div>

          <div class="grid">
            <div class="cell"><div class="k">공백 포함</div><div class="v" id="mWith">0<small>자</small></div></div>
            <div class="cell"><div class="k">공백 제외</div><div class="v" id="mNo">0<small>자</small></div></div>
            <div class="cell"><div class="k">문단</div><div class="v" id="mPara">0<small>개</small></div></div>
            <div class="cell"><div class="k">읽기 시간</div><div class="v" id="mMin">0<small>분</small></div></div>
          </div>

          <div class="sec"><span class="lab">자주 쓴 단어</span><span class="note" id="wordNote"></span></div>
          <div class="words" id="words"><div class="empty">본문을 입력하면 표시됩니다.</div></div>

          <div class="hint" id="hint" style="display:none"></div>

          <div class="sec"><span class="lab">빠른 서식</span><span class="note">커서 위치에 삽입</span></div>
          <div class="tpls" id="tpls"></div>

          <div class="foot">
            <span>저장은 이 브라우저에만</span>
            <button id="manage" title="확장 아이콘에서 서식을 관리할 수 있어요">서식 관리</button>
          </div>
        </div>
      </div>
    </div>
  `;

  const $ = (sel) => shadow.querySelector(sel);
  const bar = $('#bar');

  function setCollapsed(next) {
    collapsed = next;
    bar.classList.toggle('open', !collapsed);
    $('#chev').setAttribute('aria-label', collapsed ? '펼치기' : '접기');
  }

  $('#head').addEventListener('click', (e) => {
    if (e.target.closest('#manage')) return;
    setCollapsed(!collapsed);
  });
  $('#head').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setCollapsed(!collapsed); }
  });
  $('#manage').addEventListener('click', (e) => {
    e.stopPropagation();
    setCollapsed(false);
    const note = shadow.querySelector('.foot span');
    if (note) {
      const original = note.textContent;
      note.textContent = '크롬 툴바의 블로그랩 아이콘을 누르세요';
      note.style.color = '#9FE7BF';
      setTimeout(() => { note.textContent = original; note.style.color = ''; }, 2400);
    }
  });

  function renderTemplates() {
    const box = $('#tpls');
    if (!templates.length) {
      box.innerHTML = '<div class="empty">확장 아이콘에서 서식을 추가하세요.</div>';
      return;
    }
    box.innerHTML = '';
    templates.slice(0, 6).forEach(t => {
      const b = document.createElement('button');
      b.className = 'tpl';
      b.type = 'button';
      b.textContent = t.name;
      b.title = t.name + ' — ' + (t.body || '').slice(0, 60);
      b.addEventListener('click', () => {
        const ok = insertAtCursor(t.body);
        b.textContent = ok ? '넣었어요 ✓' : '삽입 실패';
        setTimeout(() => { b.textContent = t.name; }, 1200);
      });
      box.appendChild(b);
    });
  }

  function paint(m) {
    latest = m;
    const tLen = m.title.length;
    const sum = $('#summary');
    const badge = $('#titleVal');

    if (!m.hasEditor) {
      sum.textContent = '글쓰기 화면을 찾는 중…';
      sum.classList.remove('bad');
      return;
    }

    sum.textContent = (tLen > 30 ? '⚠ ' : '') + '제목 ' + tLen + '/30 · ' +
      m.stats.withSpace.toLocaleString('ko-KR') + '자';
    sum.classList.toggle('bad', tLen > 30);

    badge.textContent = tLen + '자 / 30자';
    badge.className = 'val ' + (tLen > 30 ? 'bad' : tLen >= 15 ? 'ok' : tLen > 0 ? 'warn' : '');
    const pct = Math.min(100, (tLen / 30) * 100);
    $('#titleFill').style.width = pct + '%';
    $('#titleMeter').classList.toggle('over', tLen > 30);

    $('#mWith').innerHTML = m.stats.withSpace.toLocaleString('ko-KR') + '<small>자</small>';
    $('#mNo').innerHTML = m.stats.noSpace.toLocaleString('ko-KR') + '<small>자</small>';
    $('#mPara').innerHTML = m.stats.paragraphs + '<small>개</small>';
    $('#mMin').innerHTML = m.stats.minutes + '<small>분</small>';

    const box = $('#words');
    if (!m.words.length) {
      box.innerHTML = '<div class="empty">본문을 입력하면 표시됩니다.</div>';
      $('#wordNote').textContent = '';
    } else {
      const max = m.words[0].c;
      box.innerHTML = m.words.map(w => `
        <div class="word ${w.c >= 6 ? 'hot' : ''}">
          <span class="w" title="${w.w.replace(/"/g, '&quot;')}">${w.w}</span>
          <span class="t"><i style="width:${Math.max(8, (w.c / max) * 100)}%"></i></span>
          <span class="c">${w.c}회</span>
        </div>`).join('');
      $('#wordNote').textContent = m.stats.noSpace ? '상위 5개' : '';
    }

    const worst = m.words[0];
    const hint = $('#hint');
    if (worst && worst.c >= 5 && (worst.c >= 8 || worst.pct >= 4.5)) {
      hint.style.display = 'block';
      hint.textContent = '‘' + worst.w + '’이(가) ' + worst.c + '회 반복됩니다. 동의어로 바꿔 보세요.';
    } else {
      hint.style.display = 'none';
    }
  }

  function refresh() {
    let m = readMetrics();
    if (frameMetrics && (frameMetrics.stats.withSpace > m.stats.withSpace)) {
      m = Object.assign({}, frameMetrics, { hasEditor: true });
    }
    // 제목이 상위 프레임에 없고 iframe에만 있으면 iframe 값 사용
    if ((!m.title || !m.title.length) && frameMetrics && frameMetrics.title) {
      m.title = frameMetrics.title;
      m.hasEditor = true;
    }
    paint(m);
  }

  window.addEventListener('message', (e) => {
    const d = e.data;
    if (!d || d.source !== 'blab-frame' || d.type !== 'metrics') return;
    if (d.payload && d.payload.stats) {
      frameMetrics = d.payload;
      refresh();
    }
  }, false);

  let rafPending = false;
  function scheduleRefresh() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; refresh(); });
  }

  document.addEventListener('input', scheduleRefresh, true);
  document.addEventListener('keyup', scheduleRefresh, true);
  setInterval(refresh, 1200);

  // iframe에 값 요청 (다른 출처로 격리된 경우 대비)
  setInterval(() => {
    eachDocument(doc => {
      try { doc.defaultView && doc.defaultView.postMessage({ source: 'blab', type: 'ping' }, '*'); } catch (e) {}
    });
  }, 4000);

  document.body.appendChild(host);

  // 페이지가 SPA처럼 다시 그려져도 바가 사라지지 않게
  const keepAliveHost = new MutationObserver(() => {
    if (!document.body.contains(host) && enabled) document.body.appendChild(host);
  });
  keepAliveHost.observe(document.documentElement, { childList: true, subtree: true });

  /* ---------------------------------------------------------------- 초기화 */
  (async function init() {
    const data = await store.get([KEY_TPL, KEY_BAR]);
    if (Array.isArray(data[KEY_TPL]) && data[KEY_TPL].length) templates = data[KEY_TPL];
    else await store.set({ [KEY_TPL]: DEFAULT_TEMPLATES });

    enabled = data[KEY_BAR] !== false;
    host.style.display = enabled ? 'block' : 'none';

    renderTemplates();
    setCollapsed(true);
    setTimeout(refresh, 400);
    setTimeout(refresh, 1500);
  })();

  onChanged((changes, area) => {
    if (area !== 'local') return;
    if (changes[KEY_TPL]) {
      const v = changes[KEY_TPL].newValue;
      templates = Array.isArray(v) && v.length ? v : DEFAULT_TEMPLATES;
      renderTemplates();
    }
    if (changes[KEY_BAR]) {
      enabled = changes[KEY_BAR].newValue !== false;
      host.style.display = enabled ? 'block' : 'none';
    }
  });
})();
