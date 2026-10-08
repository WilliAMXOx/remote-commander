/* ============================================================
   Remote Commander 多终端管理器
   层级：窗口 -> 标签页 Tabs -> 分屏树 Split(嵌套二分) -> 面板 Pane
   ============================================================ */
(function () {
  'use strict';

  let paneSeq = 0, tabSeq = 0;
  const tabs = [];
  let activeTab = null, activePane = null;

  const TERM_THEME = {
    background: '#0B0B10', foreground: '#F8FAFC', cursor: '#F8FAFC',
    selectionBackground: 'rgba(59,130,246,0.30)',
    black: '#0B0B10', red: '#EF4444', green: '#22C55E', yellow: '#FACC15',
    blue: '#3B82F6', magenta: '#E879F9', cyan: '#22D3EE', white: '#F8FAFC',
    brightBlack: '#64748B', brightRed: '#F87171', brightGreen: '#4ADE80',
    brightYellow: '#FDE047', brightBlue: '#60A5FA', brightMagenta: '#F0ABFC',
    brightCyan: '#67E8F9', brightWhite: '#FFFFFF'
  };

  function allPanes() { const r = []; for (const t of tabs) for (const p of t.panes) r.push(p); return r; }
  function tabOf(id) { return tabs.find(t => t.id === id); }

  /* ---------------- Pane ---------------- */
  class Pane {
    constructor(mode, auth) {
      this.id = 'p' + (++paneSeq);
      this.tabId = null;
      this.mode = mode;                 // 'ssh' | 'local'
      this.auth = auth || null;
      this.state = 'disconnected';
      this.manualClose = false;
      this.reconnectAttempts = 0;
      this.reconnectTimer = null;
      this.reconnectScheduled = false;
      this.readBuffer = '';
      this.markBuf = '';
      this.markWaiters = {};
      this._markSeq = 0;
      this._lineBuf = '';
      this.jumpedHost = null;
      this.jumpedUser = null;
      this.ws = null;
      this.term = null; this.fit = null; this.ro = null;
      this.fitRaf = null;
      this.mounted = false;

      this.el = document.createElement('div');
      this.el.className = 'pane';
      this.head = document.createElement('div');
      this.head.className = 'pane-head';
      this.termHost = document.createElement('div');
      this.termHost.className = 'pane-term';
      this.el.appendChild(this.head);
      this.el.appendChild(this.termHost);
      this.buildHead();

      this.el.addEventListener('mousedown', () => Manager.focus(this));
    }

    buildHead() {
      this.dot = document.createElement('span');
      this.dot.className = 'pane-dot disconnected';
      this.nameEl = document.createElement('span');
      this.nameEl.className = 'pane-name';
      this.nameEl.textContent = this.defaultTitle();

      const spacer = document.createElement('span');
      spacer.style.flex = '1';

      const mk = (cls, title, txt, fn) => {
        const b = document.createElement('button');
        b.className = 'pane-btn' + (cls ? ' ' + cls : '');
        b.title = title; b.textContent = txt;
        b.addEventListener('mousedown', e => e.stopPropagation());
        b.addEventListener('click', e => { e.stopPropagation(); fn(); });
        return b;
      };
      this.btnReconnect = mk('', '重新连接', '↻', () => { this.manualClose = false; this.reconnectAttempts = 0; this.connect(); });
      this.btnSplitH = mk('', '上下分屏 (Alt+Shift+-)', '↔', () => Manager.split(this, 'h'));
      this.btnSplitV = mk('', '左右分屏 (Alt+Shift+=)', '↕', () => Manager.split(this, 'v'));
      this.btnClose = mk('danger', '关闭 (Ctrl+Shift+W)', '✕', () => Manager.close(this));

      this.head.appendChild(this.dot);
      this.head.appendChild(this.nameEl);
      this.head.appendChild(spacer);
      this.head.appendChild(this.btnReconnect);
      this.head.appendChild(this.btnSplitH);
      this.head.appendChild(this.btnSplitV);
      this.head.appendChild(this.btnClose);
    }

    defaultTitle() {
      if (this.customTitle) return this.customTitle;
      if (this.mode === 'ssh' && this.auth) return this.auth.username + '@' + this.auth.host;
      if (this.mode === 'ssh') return 'SSH';
      return '本地 Shell';
    }

    mount() {
      this.term = new Terminal({
        cursorBlink: true, fontSize: 13,
        fontFamily: 'Roboto Mono, monospace',
        applicationKeypad: false,
        theme: TERM_THEME
      });
      this.fit = new FitAddon.FitAddon();
      this.term.loadAddon(this.fit);
      this.term.loadAddon(new WebLinksAddon.WebLinksAddon());
      this.term.open(this.termHost);
      this.mounted = true;
      this.bindTerm();
      this.ro = new ResizeObserver(() => this.scheduleFit());
      this.ro.observe(this.termHost);
      if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => this.fitNow());
      setTimeout(() => this.fitNow(), 0);
      setTimeout(() => this.fitNow(), 300);
      this.connect();
    }

    detectJumpLine(line) {
      if (!line) return;
      const m = line.match(/(?:^|;\s*)ssh\s+([A-Za-z0-9_.-]+)@([A-Za-z0-9_.-]+)/);
      if (m) {
        this.jumpedUser = m[1]; this.jumpedHost = m[2];
        if (window.onSshJumpDetected) window.onSshJumpDetected(m[1], m[2]);
        return;
      }
      if (/^\s*(exit|logout)\s*$/.test(line) && this.jumpedHost) {
        const h = this.jumpedHost;
        this.jumpedHost = null; this.jumpedUser = null;
        if (window.onSshJumpExit) window.onSshJumpExit(h);
      }
    }

    bindTerm() {
      this.term.onData(data => {
        if (!this.isOpen() || window.batchRunning) return;
        this.send({ type: 'raw', payload: utf8ToBase64(data) });
        if (this.mode === 'ssh') {
          for (const ch of data) {
            if (ch === '\r' || ch === '\n') {
              const line = this._lineBuf;
              this._lineBuf = '';
              this.detectJumpLine(line);
            } else if (ch === '\u007f' || ch === '\b') {
              this._lineBuf = this._lineBuf.slice(0, -1);
            } else {
              this._lineBuf += ch;
            }
          }
        }
      });

      this.term.attachCustomKeyEventHandler(e => {
        if (e.type !== 'keydown') return true;
        const ctrl = e.ctrlKey || e.metaKey;
        if ((ctrl && (e.key === 'v' || e.key === 'V')) ||
            (e.shiftKey && !ctrl && (e.key === 'Insert' || e.code === 'Insert'))) {
          return false;
        }
        if (ctrl && e.shiftKey && (e.key === 'c' || e.key === 'C')) {
          const sel = this.term.getSelection();
          if (sel) {
            navigator.clipboard.writeText(sel).catch(() => {});
            this.term.clearSelection();
            return false;
          }
        }
        return true;
      });

      // 粘贴
      this.termHost._pasteHandler = (e) => {
        if (!this.term.element || !this.term.element.contains(document.activeElement)) return;
        const cd = e.clipboardData || window.clipboardData;
        const text = cd ? cd.getData('text/plain') : '';
        if (text) { e.preventDefault(); e.stopPropagation(); this.term.paste(text); }
      };
      document.addEventListener('paste', this.termHost._pasteHandler, true);

      this.buildContextMenu();
    }

    buildContextMenu() {
      const menu = document.createElement('div');
      menu.className = 'term-context-menu';
      menu.innerHTML =
        '<div class="menu-item" data-act="paste">粘贴</div>' +
        '<div class="menu-item" data-act="copy">复制选中</div>' +
        '<div class="menu-item" data-act="clear">清屏</div>';
      document.body.appendChild(menu);
      this._menu = menu;
      const hide = () => menu.classList.remove('show');
      this.term.element.addEventListener('contextmenu', e => {
        e.preventDefault();
        const hasSel = this.term.hasSelection && this.term.hasSelection();
        menu.querySelector('[data-act="copy"]').classList.toggle('disabled', !hasSel);
        menu.style.left = Math.min(e.clientX, window.innerWidth - 150) + 'px';
        menu.style.top = Math.min(e.clientY, window.innerHeight - 120) + 'px';
        menu.classList.add('show');
      });
      menu.addEventListener('mousedown', e => {
        e.preventDefault();
        const item = e.target.closest('.menu-item');
        if (!item || item.classList.contains('disabled')) { hide(); return; }
        const act = item.getAttribute('data-act');
        hide();
        if (act === 'paste') {
          if (navigator.clipboard && navigator.clipboard.readText) {
            navigator.clipboard.readText().then(t => { if (t) this.term.paste(t); }).catch(() => {});
          }
        } else if (act === 'copy') {
          const sel = this.term.getSelection();
          if (sel) navigator.clipboard.writeText(sel).catch(() => {});
        } else if (act === 'clear') {
          this.term.clear();
        }
      });
      this._menuHide = hide;
    }

    isOpen() { return this.ws && this.ws.readyState === WebSocket.OPEN && this.state === 'connected'; }

    send(obj) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(obj) + '\0');
      }
    }

    setState(s) {
      this.state = s;
      this.dot.className = 'pane-dot ' + s;
      if (activePane === this) Manager.syncHeader();
    }

    connect() {
      this.clearReconnect();
      this.closeWs();
      if (this.mode === 'local') this.initLocal();
      else this.connectSsh();
    }

    initLocal() {
      this.manualClose = false;
      this.setState('connecting');
      this.readBuffer = '';
      const ws = new WebSocket(withToken(wsOrigin() + '/local-shell'));
      this.ws = ws;
      ws.onopen = () => {
        this.setState('connected');
        this.reconnectAttempts = 0;
        this.term.writeln('\x1b[32m[OK] 本地通道就绪\x1b[0m');
        this.fitNow();
      };
      ws.onmessage = e => { if (this.term) this.ingestSsh(e.data); };
      ws.onerror = () => {};
      ws.onclose = () => {
        if (this.ws !== ws) return;
        if (!this.manualClose) { this.scheduleReconnect('本地通道中断', 1000); return; }
        this.setState('disconnected');
      };
    }

    connectSsh() {
      if (!this.auth) { this.setState('disconnected'); return; }
      const { host, port, username, password, jump } = this.auth;
      this.setState(this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting');
      this.readBuffer = '';
      this.markBuf = '';
      const ws = new WebSocket(withToken(wsOrigin() + '/ssh'));
      this.ws = ws;
      ws.onopen = () => {
        this.send({ type: 'auth', host, port: port || 22, username, password, cols: this.term.cols, rows: this.term.rows });
      };
      ws.onmessage = ev => {
        handleWsMessage(ev.data,
          res => {
            // SFTP 文件传输消息优先交给 SFTP 模块处理
            if (window.handleSftpMessage && window.handleSftpMessage(res, this)) return;
            if (res.type === 'ready') {
              const wasReconnect = this.reconnectAttempts > 0;
              this.reconnectAttempts = 0;
              this.reconnectScheduled = false;
              this.setState('connected');
              if (wasReconnect) {
                this.term.writeln('\x1b[32m[OK] 链路已自动恢复\x1b[0m');
                this.term.writeln('\x1b[33m[提示] 这是一个全新的 SSH 会话，之前的工作目录 / 环境变量 / 正在运行的程序不会保留\x1b[0m');
              } else {
                this.term.writeln('\x1b[32m[OK] SSH 链路建立成功\x1b[0m');
              }
              this.fitNow();
              return;
            }
            if (res.type === 'closed') {
              this.term.writeln('\x1b[33m[WARN] ' + (res.reason || 'SSH 链路断开') + '\x1b[0m');
              try { ws.close(); } catch (e) {}
              if (!this.manualClose) this.scheduleReconnect(res.reason);
              return;
            }
            if (res.type === 'error') {
              this.term.writeln('\x1b[31m[ERROR] ' + res.message + '\x1b[0m');
              if (this.state === 'connecting') {
                this.manualClose = true;
                this.reconnectAttempts = 0;
                this.clearReconnect();
                this.closeWs();
                this.setState('disconnected');
              } else if (!this.manualClose) {
                this.scheduleReconnect(res.message);
              }
              return;
            }
            if (res.type === 'term') { this.ingestSsh(res.data); return; }
            if (res && typeof res === 'object') return;
            this.term.write(String(res));
          },
          rawStr => { this.term.write(rawStr); }
        );
      };
      ws.onerror = () => {};
      ws.onclose = () => {
        if (this.ws !== ws) return;
        if (this.manualClose) { this.setState('disconnected'); return; }
        this.scheduleReconnect('与终端服务的 WebSocket 连接中断');
      };
    }

    scheduleReconnect(reason, fixedDelay) {
      if (this.manualClose || this.reconnectScheduled) return;
      this.reconnectScheduled = true;
      this.reconnectAttempts += 1;
      this.setState('reconnecting');
      let delay;
      if (fixedDelay) delay = fixedDelay;
      else delay = Math.min(1000 * Math.pow(2, Math.min(this.reconnectAttempts - 1, 4)), 10000);
      this.term.writeln('\x1b[33m[WARN] ' + (reason || '链路断开') + '，' + Math.round(delay / 1000) +
        ' 秒后自动重连（第 ' + this.reconnectAttempts + ' 次），点标题栏 ✕ 可关闭\x1b[0m');
      this.reconnectTimer = setTimeout(() => {
        this.reconnectScheduled = false;
        if (!this.manualClose) this.connect();
      }, delay);
    }

    ingestSsh(data) {
      if (!data) return;
      this.markBuf += data;
      let out = '';
      const re = /\x1b\]777;RC([A-Za-z0-9]+)=(-?\d+)\x07/g;
      let m;
      while ((m = re.exec(this.markBuf)) !== null) {
        out += this.markBuf.slice(0, m.index);
        const cb = this.markWaiters[m[1]];
        if (cb) { delete this.markWaiters[m[1]]; cb(Number(m[2])); }
        this.markBuf = this.markBuf.slice(m.index + m[0].length);
        re.lastIndex = 0;
      }
      const oscIdx = this.markBuf.lastIndexOf('\x1b]');
      if (oscIdx !== -1 &&
          this.markBuf.indexOf('\x07', oscIdx) === -1 &&
          this.markBuf.indexOf('\x1b\\', oscIdx) === -1) {
        out += this.markBuf.slice(0, oscIdx);
        this.markBuf = this.markBuf.slice(oscIdx);
        if (this.markBuf.length > 128) { out += this.markBuf; this.markBuf = ''; }
      } else {
        out += this.markBuf; this.markBuf = '';
      }
      if (out) this.term.write(out);
    }

    fitNow() {
      if (!this.fit || !this.mounted) return;
      try { this.fit.fit(); } catch (e) { return; }
      if (this.isOpen()) this.send({ type: 'resize', cols: this.term.cols, rows: this.term.rows });
    }
    scheduleFit() {
      if (this.fitRaf) cancelAnimationFrame(this.fitRaf);
      this.fitRaf = requestAnimationFrame(() => this.fitNow());
    }

    clearReconnect() {
      if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
      this.reconnectScheduled = false;
    }
    closeWs() {
      if (this.ws) { try { this.ws.close(); } catch (e) {} this.ws = null; }
    }

    destroy() {
      this.manualClose = true;
      this.clearReconnect();
      if (this.ro) this.ro.disconnect();
      if (this.termHost._pasteHandler) document.removeEventListener('paste', this.termHost._pasteHandler, true);
      if (this._menu) this._menu.remove();
      this.closeWs();
      if (this.term) try { this.term.dispose(); } catch (e) {}
      if (this.el.parentNode) this.el.parentNode.removeChild(this.el);
      this.mounted = false;
    }
  }

  /* ---------------- Resizer ---------------- */
  function makeResizer(orient) {
    const rz = document.createElement('div');
    rz.className = 'resizer ' + orient;
    rz.addEventListener('mousedown', e => {
      e.preventDefault();
      const horizontal = orient === 'h';
      const a = prevLayoutEl(rz), b = nextLayoutEl(rz);
      if (!a || !b) return;
      const start = horizontal ? e.clientY : e.clientX;
      const container = rz.parentNode;
      const big = horizontal ? container.getBoundingClientRect().height : container.getBoundingClientRect().width;
      const aSize = horizontal ? a.getBoundingClientRect().height : a.getBoundingClientRect().width;
      const move = ev2 => {
        const cur = horizontal ? ev2.clientY : ev2.clientX;
        let pa = (aSize + (cur - start)) / big * 100;
        pa = Math.max(10, Math.min(90, pa));
        a.style.flex = '0 0 ' + pa + '%';
        b.style.flex = '0 0 ' + (100 - pa) + '%';
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        const panes = collectPanes(container);
        panes.forEach(p => p.fitNow());
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    return rz;
  }
  function prevLayoutEl(node) { let s = node.previousElementSibling; while (s && s.classList.contains('resizer')) s = s.previousElementSibling; return s; }
  function nextLayoutEl(node) { let s = node.nextElementSibling; while (s && s.classList.contains('resizer')) s = s.nextElementSibling; return s; }
  function collectPanes(root) {
    return allPanes().filter(p => root.contains(p.el));
  }

  /* ---------------- Manager ---------------- */
  const Manager = {
    createTab(mode, auth) {
      const content = document.createElement('div');
      content.className = 'tab-content';
      const tab = { id: 't' + (++tabSeq), content, panes: [], item: null, label: null };
      $('terminalWrapper').appendChild(content);

      const item = document.createElement('div');
      item.className = 'tab-item';
      const label = document.createElement('span');
      label.className = 'tab-label';
      label.textContent = '终端 ' + tabSeq;
      const close = document.createElement('span');
      close.className = 'tab-close';
      close.textContent = '✕';
      close.addEventListener('click', e => { e.stopPropagation(); this.closeTab(tab); });
      item.appendChild(label); item.appendChild(close);
      item.addEventListener('click', () => this.switchTab(tab));
      tab.item = item; tab.label = label;

      const newBtn = $('tabBar').querySelector('.tab-new');
      $('tabBar').insertBefore(item, newBtn);
      tabs.push(tab);

      const pane = new Pane(mode, auth);
      pane.tabId = tab.id;
      content.appendChild(pane.el);
      tab.panes.push(pane);

      this.switchTab(tab);
      pane.mount();
      this.focus(pane);
      this.updateTabTitle(tab);
      return tab;
    },

    switchTab(tab) {
      activeTab = tab;
      for (const t of tabs) {
        t.content.classList.toggle('active', t === tab);
        if (t.item) t.item.classList.toggle('active', t === tab);
      }
      const fp = tab.panes.find(p => p === activePane) || tab.panes[0];
      if (fp) this.focus(fp);
    },

    closeTab(tab) {
      const idx = tabs.indexOf(tab);
      tab.panes.slice().forEach(p => p.destroy());
      tab.content.remove();
      tab.item.remove();
      tabs.splice(idx, 1);
      if (tabs.length === 0) {
        activeTab = null; activePane = null;
        this.createTab('local');
        return;
      }
      const next = tabs[Math.max(0, idx - 1)];
      this.switchTab(next);
    },

    split(pane, dir, mode, auth) {
      const useMode = mode || pane.mode;
      const useAuth = auth || (useMode === pane.mode ? pane.auth : null);
      const np = new Pane(useMode, useAuth);
      np.tabId = pane.tabId;
      const needDir = dir === 'h' ? 'col' : 'row';
      const parent = pane.el.parentNode;
      let split;
      if (parent.classList.contains('split') && parent.classList.contains(needDir)) {
        split = parent;
        const rz = makeResizer(dir);
        pane.el.insertAdjacentElement('afterend', rz);
        rz.insertAdjacentElement('afterend', np.el);
      } else {
        split = document.createElement('div');
        split.className = 'split ' + needDir;
        parent.insertBefore(split, pane.el);
        split.appendChild(pane.el);
        split.appendChild(makeResizer(dir));
        split.appendChild(np.el);
      }
      const tab = tabOf(pane.tabId);
      tab.panes.push(np);
      np.mount();
      this.focus(np);
      this.updateTabTitle(tab);
      return np;
    },

    close(pane) {
      const tab = tabOf(pane.tabId);
      const parent = pane.el.parentNode;
      // 同时移除相邻 resizer
      const prevSib = pane.el.previousElementSibling;
      if (prevSib && prevSib.classList.contains('resizer')) prevSib.remove();
      else { const nx = pane.el.nextElementSibling; if (nx && nx.classList.contains('resizer')) nx.remove(); }

      pane.destroy();
      tab.panes = tab.panes.filter(p => p !== pane);

      if (parent.classList.contains('split')) {
        const kids = Array.prototype.slice.call(parent.children).filter(c => !c.classList.contains('resizer'));
        if (kids.length === 1) {
          const child = kids[0];
          parent.parentNode.insertBefore(child, parent);
          parent.remove();
        } else if (kids.length === 0) {
          parent.remove();
        }
      }

      if (tab.panes.length === 0) { this.closeTab(tab); return; }
      this.focus(tab.panes[tab.panes.length - 1]);
      this.updateTabTitle(tab);
    },

    focus(pane) {
      if (!pane) return;
      const tab = tabOf(pane.tabId);
      if (activeTab !== tab) this.switchTabKeep(tab, pane);
      if (activePane && activePane !== pane) activePane.el.classList.remove('active');
      activePane = pane;
      pane.el.classList.add('active');
      this.syncHeader();
      try { pane.term.focus(); } catch (e) {}
      if (window.renderLibs) window.renderLibs();
      if (window.sftpRebindToFocus) window.sftpRebindToFocus(pane);
    },

    // 切 tab 但不立即把焦点交给该 tab 的旧 pane（用于指定 pane 聚焦）
    switchTabKeep(tab, pane) {
      activeTab = tab;
      for (const t of tabs) {
        t.content.classList.toggle('active', t === tab);
        if (t.item) t.item.classList.toggle('active', t === tab);
      }
    },

    syncHeader() {
      if (!activePane) return;
      window.currentMode = activePane.mode;
      window.isConnected = activePane.state === 'connected';
      const dot = $('statusDot'), label = $('statusLabel'), info = $('sessionInfo');
      if (dot) dot.className = 'dot ' + activePane.state;
      if (label) {
        const map = {
          connected: activePane.mode === 'local' ? '本地 Shell 连通' : ('已连接 ' + (activePane.auth ? activePane.auth.host : '')),
          connecting: '链路连接中', reconnecting: '重连中…', disconnected: '系统未连接'
        };
        label.textContent = map[activePane.state] || '系统未连接';
      }
      if (info) info.textContent = '终端 ' + allPanes().length + ' 个';
    },

    updateTabTitle(tab) {
      if (!tab.panes.length) return;
      const modes = new Set(tab.panes.map(p => p.mode));
      let title;
      if (tab.panes.length === 1) title = tab.panes[0].defaultTitle();
      else if (modes.size === 1) title = (modes.has('ssh') ? 'SSH' : '本地') + ' ×' + tab.panes.length;
      else title = '混合 ×' + tab.panes.length;
      tab.label.textContent = title;
    },

    moveFocus(dir) {
      const cur = activePane; if (!cur) return;
      const r = cur.el.getBoundingClientRect();
      const rc = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      let best = null, bestScore = Infinity;
      for (const p of allPanes()) {
        if (p === cur || !p.mounted) continue;
        const b = p.el.getBoundingClientRect();
        const x = b.left + b.width / 2, y = b.top + b.height / 2;
        let ok = false, primary = 0, secondary = 0;
        if (dir === 'left') { ok = x < r.left; primary = rc.x - x; secondary = Math.abs(y - rc.y); }
        if (dir === 'right') { ok = x > r.right; primary = x - rc.x; secondary = Math.abs(y - rc.y); }
        if (dir === 'up') { ok = y < r.top; primary = rc.y - y; secondary = Math.abs(x - rc.x); }
        if (dir === 'down') { ok = y > r.bottom; primary = y - rc.y; secondary = Math.abs(x - rc.x); }
        const score = primary * 2 + secondary;
        if (ok && score < bestScore) { bestScore = score; best = p; }
      }
      if (best) this.focus(best);
    },

    resizeBy(dir) {
      const cur = activePane; if (!cur) return;
      const parent = cur.el.parentNode;
      if (!parent.classList.contains('split')) return;
      const horizontal = parent.classList.contains('col');
      let sib, delta;
      if (horizontal) {
        if (dir === 'up') { sib = prevLayoutEl(cur.el); delta = -24; }
        else if (dir === 'down') { sib = nextLayoutEl(cur.el); delta = 24; }
      } else {
        if (dir === 'left') { sib = prevLayoutEl(cur.el); delta = -24; }
        else if (dir === 'right') { sib = nextLayoutEl(cur.el); delta = 24; }
      }
      if (!sib) return;
      const big = horizontal ? parent.getBoundingClientRect().height : parent.getBoundingClientRect().width;
      const cSize = horizontal ? cur.el.getBoundingClientRect().height : cur.el.getBoundingClientRect().width;
      let pa = (cSize + delta) / big * 100;
      pa = Math.max(10, Math.min(90, pa));
      cur.el.style.flex = '0 0 ' + pa + '%';
      sib.style.flex = '0 0 ' + (100 - pa) + '%';
      collectPanes(parent).forEach(p => p.fitNow());
    }
  };

  /* ---------------- 对外创建函数 ---------------- */
  function gatherSshAuth() {
    const host = $('hostInput').value.trim();
    const port = $('portInput').value.trim() || 22;
    const username = $('userInput').value.trim();
    const password = $('passInput').value;
    const saveFlag = $('saveLoginInfo').checked;
    if (!host || !username) { alert('请完整填写 IP 与账号'); return null; }
    if (saveFlag) {
      localStorage.setItem('sshLoginInfo', JSON.stringify({ host, port, user: username, pass: password }));
      let existing = window.savedAccounts.find(a => a.host === host);
      if (existing) { existing.user = username; existing.pass = password; existing.port = port; }
      else window.savedAccounts.push({ host, port, user: username, pass: password });
      localStorage.setItem('rc_saved_accounts', JSON.stringify(window.savedAccounts));
      if (window.initAccountDropdown) initAccountDropdown();
    } else {
      localStorage.removeItem('sshLoginInfo');
    }
    return { host, port: Number(port), username, password };
  }

  window.createLocal = function (where) {
    if (where === 'tab' || !activePane) Manager.createTab('local');
    else Manager.split(activePane, 'v', 'local', null);
  };
  window.createSsh = function (where) {
    const auth = gatherSshAuth();
    if (!auth) return;
    if (where === 'tab' || !activePane) Manager.createTab('ssh', auth);
    else Manager.split(activePane, 'v', 'ssh', auth);
  };
  // 在选定终端右侧分屏，独立执行系统命令 ssh hzhy@192.168.8.88（sshpass 自动填密码）
  window.createQuickSsh = function () {
    const base = activePane;
    if (!base) { alert('请先选择一个终端'); return; }
    // 新分屏与选定终端同类型（本地 / 远程跳板），不指定 auth 时自动继承
    const np = Manager.split(base, 'v');
    if (!np) return;
    // 窗口标题：hzhy@192.168.8.88 经 <当前终端用户>@<当前终端IP>
    const baseHost = (base.auth && base.auth.host) ? base.auth.host : '192.168.8.88';
    const baseUser = (base.auth && base.auth.username) ? base.auth.username : 'ssh';
    np.customTitle = 'hzhy@192.168.8.88 经 ' + baseUser + '@' + baseHost;
    if (np.nameEl) np.nameEl.textContent = np.customTitle;
    const run = "ssh -o StrictHostKeyChecking=no hzhy@192.168.8.88";
    // 等待新终端通道就绪
    let tries = 0;
    const timer = setInterval(() => {
      tries += 1;
      if (np.isOpen && np.isOpen()) {
        clearInterval(timer);
        // 等 shell 登录流程/提示符完全就绪；先回车刷出干净提示符，再用 \r 提交整段命令
        setTimeout(() => {
          np.send({ type: 'raw', payload: utf8ToBase64('\r') });
          setTimeout(() => {
            np.send({ type: 'raw', payload: utf8ToBase64(run + '\r') });
          }, 350);
        }, 700);
        Manager.updateTabTitle(tabOf(np.tabId));
      } else if (tries > 50) {
        clearInterval(timer);
      }
    }, 200);
  };
  window.focusPane = function () { return activePane; };

  /* ---------------- 兼容垫片 ---------------- */
  window.term = {
    write: d => { if (activePane) activePane.term.write(d); },
    writeln: d => { if (activePane) activePane.term.writeln(d); },
    clear: () => { if (activePane) activePane.term.clear(); },
    reset: () => { if (activePane) activePane.term.reset(); },
    paste: t => { if (activePane) activePane.term.paste(t); },
    focus: () => { if (activePane) activePane.term.focus(); },
    getSelection: () => (activePane ? activePane.term.getSelection() : ''),
    hasSelection: () => (activePane ? activePane.term.hasSelection() : false),
    clearSelection: () => { if (activePane) activePane.term.clearSelection(); },
    get cols() { return activePane ? activePane.term.cols : 80; },
    get rows() { return activePane ? activePane.term.rows : 30; },
    get element() { return activePane ? activePane.term.element : null; }
  };
  window.wsSend = function (obj) { if (activePane) activePane.send(obj); };

  // 批量单命令：标记注册到聚焦 pane
  window.runOneBatchCmd = function (text, timeoutMs) {
    return new Promise(resolve => {
      const p = activePane;
      if (!p) { resolve(-1); return; }
      p._markSeq += 1;
      const id = 'C' + p._markSeq;
      let done = false;
      const finish = code => {
        if (done) return; done = true; resolve(code);
      };
      p.markWaiters[id] = finish;
      const payload = (p.mode === 'ssh' ? 'echo __RC_' + id + '__; ' : '') + text +
        '; code=$?; printf "\\033]777;RC' + id + '=%d\\007" $code';
      window.wsSend({ type: 'raw', payload: utf8ToBase64(payload) });
      setTimeout(() => finish(-1), timeoutMs || 30000);
    });
  };

  /* ---------------- 快捷键 ---------------- */
  function isTypingTarget() {
    const el = document.activeElement;
    if (!el) return false;
    if (el.classList && el.classList.contains('xterm-helper-textarea')) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { if (window.closeHistoryPopover) closeHistoryPopover(); return; }
    if (isTypingTarget()) return;

    if (e.altKey && e.shiftKey && e.code === 'Minus') { e.preventDefault(); if (activePane) Manager.split(activePane, 'h'); return; }
    if (e.altKey && e.shiftKey && e.code === 'Equal') { e.preventDefault(); if (activePane) Manager.split(activePane, 'v'); return; }
    if (e.ctrlKey && e.shiftKey && (e.key === 'W' || e.key === 'w')) { e.preventDefault(); if (activePane) Manager.close(activePane); return; }
    if (e.ctrlKey && e.shiftKey && (e.key === 'T' || e.key === 't')) { e.preventDefault(); Manager.createTab('local'); return; }
    if (e.altKey && !e.shiftKey) {
      const map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
      if (map[e.key]) { e.preventDefault(); Manager.moveFocus(map[e.key]); return; }
    }
    if (e.altKey && e.shiftKey) {
      const map = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
      if (map[e.key]) { e.preventDefault(); Manager.resizeBy(map[e.key]); return; }
    }
  }, true);

  /* ---------------- 启动 ---------------- */
  function printBanner(pane) {
    const t = pane.term;
    t.writeln('\x1b[32m╔════════════════════════════════════════════════╗\x1b[0m');
    t.writeln('\x1b[32m║            >> 远程操作系统 V1.11.6             ║\x1b[0m');
    t.writeln('\x1b[32m║   多标签 / 分屏 / 跨模式混合 / 心跳断线重连    ║\x1b[0m');
    t.writeln('\x1b[32m║   任务搜索批量执行 / 界面光效 / 版本更新检查   ║\x1b[0m');
    t.writeln('\x1b[32m╚════════════════════════════════════════════════╝\x1b[0m');
    t.writeln('');
    t.writeln('\x1b[36m快捷键：Alt+Shift+-/= 分屏 · Alt+方向键 切焦点 · Ctrl+Shift+W 关闭面板 · Ctrl+Shift+T 新标签\x1b[0m');
    t.writeln('');
  }

  const firstTab = Manager.createTab('local');
  const firstPane = firstTab.panes[0];
  const ws0 = firstPane.ws;
  if (ws0) {
    ws0.addEventListener('open', () => printBanner(firstPane), { once: true });
  }
})();
