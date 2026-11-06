// Renderer do Arkivo para PC — sem framework. Só fala com o processo principal via `window.arkivo`.
// Textos seguem o protótipo (docs/design/prototype-logic.js.txt).

(() => {
  const bridge = window.arkivo;
  const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  const isWin = bridge.platform === 'win32';
  const sep = isWin ? '\\' : '/';

  type View = 'atividade' | 'enviar' | 'pastas' | 'config';
  type Dialog =
    | { kind: 'logout' }
    | { kind: 'fs-remove'; id: string; label: string }
    | { kind: 'fs-rename'; id: string; label: string }
    /** Liberar uma unidade inteira (e trocar as pastas dela, se houver): aviso e confirmação (§10.13). */
    | { kind: 'fs-confirm-add'; confirm: FsAddConfirm }
    /** Mais de um celular pareado (§11): `files` = soltos na janela; `null` = abrir o seletor depois de escolher. */
    | { kind: 'outbox-phone'; files: File[] | null };

  /** Capacidade do celular que sabe receber (§11). */
  const FS_PUSH = 'fs-push';

  /** Motivos de recusa da última escolha de arquivos e erro geral da tela "Enviar para o celular". */
  let outboxRejected: { name: string; reason: string }[] = [];
  let outboxError: string | null = null;

  let state: UiState | null = null;
  let view: View = 'atividade';
  let dialog: Dialog | null = null;
  /** Texto digitado no diálogo "Renomear" (o diálogo é redesenhado por innerHTML). */
  let renameDraft = '';
  /** Recusa ao adicionar/renomear pasta liberada (texto do §10.13). */
  let fsError: string | null = null;
  /** "Unidades deste PC": a primeira enumeração já voltou / há uma em andamento. */
  let drivesLoaded = false;
  let drivesRefreshing = false;
  let busy = false;
  /** Momento do último "Copiar código" (mostra "Copiado" por alguns segundos). */
  let copiedAt = 0;
  const rendered: Record<string, string> = {};

  document.body.classList.add(`platform-${bridge.platform}`);

  // ------------------------------------------------------------------ formatação

  function esc(v: unknown): string {
    return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  }

  const comma = (n: number, digits = 1) => n.toFixed(digits).replace('.', ',');

  /** Mesmo formato do protótipo (MB/GB decimais, vírgula). */
  function fmtSize(bytes: number): string {
    const mb = bytes / 1e6;
    if (mb >= 1000) return `${comma(mb / 1000)} GB`;
    if (mb >= 10) return `${Math.round(mb)} MB`;
    if (mb >= 0.1) return `${comma(mb)} MB`;
    return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
  }

  function fmtSpeed(bps: number): string {
    const mb = bps / 1e6;
    if (mb >= 10) return `${Math.round(mb)} MB/s`;
    if (mb >= 1) return `${comma(mb)} MB/s`;
    return `${Math.max(1, Math.round(bps / 1e3))} KB/s`;
  }

  function diskLabel(s: UiState): string {
    if (s.freeBytes == null || !s.storageDir) return '';
    const gb = comma(s.freeBytes / 1e9);
    const drive = /^[A-Za-z]:/.exec(s.storageDir)?.[0];
    return drive ? `${gb} GB livres em ${drive.toUpperCase()}` : `${gb} GB livres neste disco`;
  }

  function folderOf(relativePath: string | null): string {
    if (!relativePath) return '—';
    const parts = relativePath.split('/');
    parts.pop();
    return parts.join(sep);
  }

  function shortHash(h: string | null): string {
    return h ? `${h.slice(0, 4)}…${h.slice(-4)}` : '';
  }

  function autostartText(): string {
    if (bridge.platform === 'darwin') return 'Iniciar com o macOS e rodar em segundo plano';
    if (bridge.platform === 'linux') return 'Iniciar com o sistema e rodar em segundo plano';
    return 'Iniciar com o Windows e rodar em segundo plano';
  }

  function platformName(p: UiState['platform']): string {
    return p === 'windows' ? 'Windows' : p === 'macos' ? 'macOS' : 'Linux';
  }

  function relativeTime(iso: string): string {
    const diff = Math.max(0, Date.now() - Date.parse(iso));
    const min = Math.round(diff / 60_000);
    if (min < 1) return 'agora';
    if (min < 60) return `há ${min} min`;
    const h = Math.round(min / 60);
    if (h < 24) return `há ${h} h`;
    const d = Math.round(h / 24);
    return d === 1 ? 'ontem' : `há ${d} dias`;
  }

  function routeLabel(r: UiState['lastRoute']): string {
    if (r === 'lan') return 'Mesma rede Wi-Fi · envio direto';
    if (r === 'relay') return 'Fora de casa · via relay do servidor';
    return 'Aguardando o primeiro envio';
  }

  function phoneLabel(s: UiState): string {
    if (!s.phones.length) return 'Celular';
    const first = s.phones[0].name || 'Celular';
    return s.phones.length > 1 ? `${first} e mais ${s.phones.length - 1}` : first;
  }

  // ------------------------------------------------------------------ peças

  function pathRow(s: UiState): string {
    return `
      <div class="path-row">
        <span class="input path-field" title="${esc(s.storageDir)}"><i class="ph ph-folder"></i><span class="selectable">${esc(s.storageDir ?? '')}</span></span>
        <button type="button" class="btn btn-secondary" data-action="choose-folder">Alterar…</button>
      </div>`;
  }

  function autostartToggle(s: UiState): string {
    return `<button type="button" class="check" data-action="toggle-autostart" role="checkbox" aria-checked="${s.autostart}">
      <i class="ph ${s.autostart ? 'ph-check-square' : 'ph-square'}"></i>${esc(autostartText())}</button>`;
  }

  function errorLine(s: UiState): string {
    return s.error ? `<span class="error-text"><i class="ph ph-warning-circle"></i>${esc(s.error)}</span>` : '';
  }

  // ------------------------------------------------------------------ telas

  function folderStep(s: UiState): string {
    return `
      <section class="step">
        <span class="step-kicker">Passo 1 de 2</span>
        <h2 class="step-title">Onde guardar seus arquivos?</h2>
        <p class="step-lead">Tudo que vier do celular vai para esta pasta, organizado por ano e mês.</p>
        ${pathRow(s)}
        <span class="muted tnum">${esc(diskLabel(s))}</span>
        ${autostartToggle(s)}
        ${errorLine(s)}
        <div class="spacer"></div>
        <button type="button" class="btn btn-primary btn-continue" data-action="continue" ${busy ? 'disabled' : ''}>Continuar</button>
      </section>`;
  }

  function qrStep(s: UiState): string {
    const p = s.pairing;
    const img = p?.qrDataUrl
      ? `<img src="${esc(p.qrDataUrl)}" alt="QR Code para parear o celular" />`
      : `<i class="ph ph-circle-notch spin qr-wait"></i>`;
    let status = '<i class="ph ph-circle-notch spin"></i>Aguardando o celular…';
    if (!p || p.status === 'creating') status = '<i class="ph ph-circle-notch spin"></i>Gerando código…';
    else if (p.status === 'error') status = `<i class="ph ph-wifi-slash"></i>${esc(p.error ?? 'Sem conexão com o servidor. Tentando de novo…')}`;
    else if (p.status === 'claimed') status = '<i class="ph ph-circle-notch spin"></i>Celular encontrado, conectando…';
    const link = p?.status === 'waiting' ? p.link : null;
    const copied = Date.now() - copiedAt < 2500;
    const manual = link
      ? `<div class="qr-manual">
          <span class="qr-manual-label">Não consegue escanear? Copie o código e cole no app do celular, em "Digitar código".</span>
          <input class="qr-code" type="text" readonly value="${esc(link)}" aria-label="Código de pareamento" data-action="select-link" />
          <button type="button" class="btn btn-secondary btn-copy" data-action="copy-link">
            <i class="ph ${copied ? 'ph-check' : 'ph-copy'}"></i>${copied ? 'Copiado' : 'Copiar código'}</button>
        </div>`
      : '';
    return `
      <section class="qr-step">
        <div class="qr-col">
          <div class="qr-box">${img}</div>
          ${manual}
        </div>
        <div class="qr-side">
          ${s.note ? `<span class="note"><i class="ph ph-info"></i>${esc(s.note)}</span>` : ''}
          <span class="step-kicker">Passo 2 de 2</span>
          <h2 class="qr-title">Escaneie com o app Arkivo no celular</h2>
          <p class="qr-lead">No celular, toque em "Escanear QR Code". Este código vale uma vez só.</p>
          <span class="qr-meta tnum"><i class="ph ph-timer"></i>Expira em <span id="qr-left">${esc(qrLeft(s))}</span></span>
          <span class="qr-status">${status}</span>
          <button type="button" class="link" data-action="choose-folder">Pasta: ${esc(s.storageDir ?? '')}</button>
        </div>
      </section>`;
  }

  /** A API recusou esta versão (contrato §9): tela bloqueante, sem ações além de abrir a pasta. */
  function updateStep(s: UiState): string {
    const min = s.updateRequired?.minVersion;
    const lead = min
      ? `Esta versão (${esc(s.appVersion)}) não é mais aceita pelo servidor. Instale a versão ${esc(min)} ou mais nova para voltar a receber os backups do celular.`
      : `Esta versão (${esc(s.appVersion)}) não é mais aceita pelo servidor. Instale a versão mais recente para voltar a receber os backups do celular.`;
    return `
      <section class="step update-step" role="alert">
        <i class="ph ph-arrow-circle-up update-icon"></i>
        <span class="step-kicker">Atualização necessária</span>
        <h2 class="step-title">Atualize o Arkivo para PC</h2>
        <p class="step-lead">${lead}</p>
        <div class="update-versions tnum">
          <span><span class="muted">Instalada</span><strong>${esc(s.appVersion)}</strong></span>
          <span><span class="muted">Mínima</span><strong>${esc(min ?? 'mais recente')}</strong></span>
        </div>
        <span class="note"><i class="ph ph-info"></i>Seus arquivos já salvos continuam na pasta e o pareamento é mantido. Depois de atualizar, o Arkivo retoma sozinho.</span>
        ${s.storageDir ? `<button type="button" class="link" data-action="open-folder">Abrir a pasta ${esc(s.storageDir)}</button>` : ''}
      </section>`;
  }

  function qrLeft(s: UiState): string {
    const exp = s.pairing?.expiresAt;
    if (!exp || s.pairing?.status !== 'waiting') return '5:00';
    const left = Math.max(0, Math.ceil((exp - Date.now()) / 1000));
    return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
  }

  function sidebar(s: UiState): string {
    const nav = (
      [
        ['atividade', 'Atividade', 'ph-pulse'],
        ['enviar', 'Enviar para o celular', 'ph-paper-plane-tilt'],
        ['pastas', 'Pastas liberadas', 'ph-folders'],
        ['config', 'Configurações', 'ph-gear'],
      ] as const
    )
      .map(([k, label, icon]) => `<button type="button" class="nav-btn ${view === k ? 'on' : ''}" data-action="nav" data-view="${k}" aria-current="${view === k}"><i class="ph ${icon}"></i>${label}</button>`)
      .join('');

    const rootName = (s.storageDir ?? '').split(/[\\/]/).filter(Boolean).pop() ?? 'Arkivo';
    const byYear = new Map<string, { month: string; count: number }[]>();
    for (const m of s.months) {
      const [y, mm] = m.month.split('-');
      if (!byYear.has(y)) byYear.set(y, []);
      byYear.get(y)!.push({ month: mm, count: m.count });
    }
    if (!byYear.size) {
      const now = new Date();
      byYear.set(String(now.getFullYear()), [{ month: String(now.getMonth() + 1).padStart(2, '0'), count: 0 }]);
    }
    let tree = `<button type="button" class="tree-open tree-row" data-action="open-folder" title="Abrir a pasta"><i class="ph ph-folder-open"></i><span class="name">${esc(rootName)}</span></button>`;
    for (const [year, months] of [...byYear.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
      tree += `<span class="tree-row l1"><i class="ph ph-folder-open"></i><span class="name">${esc(year)}</span></span>`;
      for (const m of months.sort((a, b) => b.month.localeCompare(a.month))) {
        const label = `${m.month} · ${MONTHS[Number(m.month) - 1] ?? ''}`;
        tree += `<span class="tree-row l2 ${m.count ? '' : 'empty'}"><i class="ph ph-folder"></i><span class="name">${esc(label)}</span><span class="count tnum">${m.count || ''}</span></span>`;
      }
    }
    return `${nav}<span class="section-label">Pasta</span>${tree}`;
  }

  function headline(s: UiState): { title: string; speed: string; on: boolean } {
    const n = s.active.length + s.queued;
    const online = s.serverConnected || s.lan.listening;
    if (n > 0) {
      const route = s.active[0]?.route ?? s.lastRoute;
      const where = route === 'relay' ? 'relay' : 'rede local';
      const speed = s.speedBps && s.speedBps > 0 ? `${fmtSpeed(s.speedBps)} · ${where}` : `Conectando · ${where}`;
      return { title: `Recebendo ${n} ${n === 1 ? 'arquivo' : 'arquivos'}`, speed, on: true };
    }
    if (s.totalSaved > 0) return { title: `${s.totalSaved} ${s.totalSaved === 1 ? 'arquivo guardado' : 'arquivos guardados'}`, speed: online ? 'Em dia' : 'Sem conexão', on: online };
    return { title: 'Pareado com o celular', speed: online ? 'Aguardando' : 'Sem conexão', on: online };
  }

  function logRows(s: UiState): string {
    const rows: string[] = [];
    for (const a of s.active) {
      const pct = a.total ? Math.floor((a.received / a.total) * 100) : 0;
      const status = a.phase === 'verifying' ? 'Conferindo hash…' : `Recebendo ${pct}%`;
      rows.push(`<tr><td class="name" title="${esc(a.name)}">${esc(a.name)}</td><td class="folder tnum">${esc(a.folder.split('/').join(sep))}</td><td class="size right tnum">${esc(fmtSize(a.total))}</td><td class="verify tnum">${esc(status)}</td></tr>`);
    }
    for (const e of s.log) {
      if (e.status === 'saved') {
        rows.push(`<tr><td class="name" title="${esc(e.name)}">${esc(e.name)}</td><td class="folder tnum">${esc(folderOf(e.relativePath))}</td><td class="size right tnum">${esc(fmtSize(e.size))}</td><td class="verify ok tnum" title="${esc(e.hash)}">✓ SHA-256 ${esc(shortHash(e.hash))}</td></tr>`);
      } else {
        rows.push(`<tr><td class="name" title="${esc(e.name)}">${esc(e.name)}</td><td class="folder">—</td><td class="size right">—</td><td class="verify fail" title="${esc(e.error)}">✕ ${esc(e.error ?? 'Falhou')}</td></tr>`);
      }
    }
    return rows.join('');
  }

  function activityView(s: UiState): string {
    const h = headline(s);
    const rows = logRows(s);
    const lanWarn = s.lan.error ? `<span><i class="ph ph-warning"></i>${esc(s.lan.error)}</span>` : '';
    return `
      <section class="activity">
        <div class="activity-head">
          <div class="titles">
            <span class="headline">${esc(h.title)}</span>
            <span class="subline">${esc(phoneLabel(s))} · ${esc(routeLabel(s.active[0]?.route ?? s.lastRoute))}</span>
          </div>
          <span class="speed tnum ${h.on ? '' : 'off'}"><span class="dot ${h.on ? '' : 'off'}"></span>${esc(h.speed)}</span>
        </div>
        <div class="log">
          ${
            rows
              ? `<table class="table"><thead><tr><th>Arquivo</th><th>Pasta</th><th class="right">Tamanho</th><th>Verificação</th></tr></thead><tbody>${rows}</tbody></table>`
              : `<p class="log-empty">Pareado. Esperando o celular escolher o que copiar.</p>`
          }
        </div>
        <div class="footer tnum">
          <span>${esc(diskLabel(s))}</span>
          ${lanWarn}
          <span><i class="ph ph-tray"></i>Rodando em segundo plano</span>
        </div>
      </section>`;
  }

  function phoneStatus(s: UiState): string {
    const recent = s.lastActivityAt && Date.now() - Date.parse(s.lastActivityAt) < 2 * 60_000;
    if (recent && s.lastRoute) return `Online · ${s.lastRoute === 'lan' ? 'mesma rede Wi-Fi' : 'via relay'}`;
    if (s.lastActivityAt) return `Último envio ${relativeTime(s.lastActivityAt)}${s.lastRoute ? ` · ${s.lastRoute === 'lan' ? 'rede local' : 'relay'}` : ''}`;
    return 'Pareado · aguardando o primeiro envio';
  }

  function settingsView(s: UiState): string {
    const name = s.account?.name || 'Sua conta';
    const initial = (name.trim()[0] || 'A').toUpperCase();
    const phones = s.phones.length
      ? s.phones
          .map(
            (p) => `
        <div class="card-row">
          <i class="ph ph-device-mobile phone-icon"></i>
          <span class="card-text"><span class="t">${esc(p.name || 'Celular')}</span><span class="s">${esc(phoneStatus(s))}</span></span>
          <button type="button" class="btn btn-ghost" data-action="unpair">Desconectar</button>
        </div>`,
          )
          .join('')
      : `<div class="card-row"><i class="ph ph-device-mobile phone-icon"></i><span class="card-text"><span class="t">Nenhum celular encontrado</span><span class="s">A lista atualiza quando o PC conecta ao servidor</span></span></div>`;
    return `
      <section class="settings">
        <span class="settings-title">Configurações</span>
        <span class="section-label">Conta</span>
        <div class="card-row">
          <span class="avatar">${esc(initial)}</span>
          <span class="card-text"><span class="t">${esc(name)}</span><span class="s">${s.account?.email ? esc(s.account.email) : s.account?.handle ? `@${esc(s.account.handle)}` : ''}</span></span>
          <span class="server-status ${s.serverConnected ? '' : 'off'}"><span class="dot sm ${s.serverConnected ? '' : 'off'}"></span>${s.serverConnected ? 'Conectado ao servidor' : 'Reconectando ao servidor…'}</span>
        </div>
        <span class="section-label gap">Celulares pareados</span>
        ${phones}
        <span class="section-label gap">Armazenamento</span>
        ${pathRow(s)}
        <span class="muted small tnum">${esc(diskLabel(s))}</span>
        ${autostartToggle(s)}
        ${errorLine(s)}
        ${s.secretsProtected ? '' : '<span class="warn-line"><i class="ph ph-lock-open"></i>O cofre de senhas do sistema não está disponível; a chave do pareamento fica só protegida pelas permissões do seu usuário.</span>'}
        <div class="settings-foot">
          <span class="version">Arkivo para PC ${esc(s.appVersion)} · ${esc(platformName(s.platform))}</span>
          <button type="button" class="btn btn-secondary" data-action="ask-logout"><i class="ph ph-sign-out"></i>Sair da conta neste PC</button>
        </div>
      </section>`;
  }

  // ------------------------------------------------------------------ pastas liberadas (§10.13)

  function baseName(p: string | null): string {
    return p ? (p.split('/').pop() ?? p) : '';
  }

  function dirName(p: string | null): string {
    if (!p) return '';
    const i = p.lastIndexOf('/');
    return i < 0 ? '' : p.slice(0, i);
  }

  /** "Fotos/2026": rótulo da raiz + pasta dentro dela. */
  function whereIn(rootLabel: string | null, rel: string): string {
    return [rootLabel ?? '', rel].filter(Boolean).join('/') || 'a pasta liberada';
  }

  function auditText(e: FsAuditUiEntry): string {
    const who = e.phoneName || 'Celular';
    const items = (n: number) => `${n} ${n === 1 ? 'item' : 'itens'}`;
    switch (e.op) {
      case 'browse':
        return `${who} navegou pelas pastas`;
      case 'upload':
        return `${who} enviou "${baseName(e.path)}" para ${whereIn(e.rootLabel, dirName(e.path))}`;
      case 'download':
        return `${who} baixou "${baseName(e.path)}"`;
      case 'trash':
        return e.path && e.count === 1 ? `${who} mandou "${baseName(e.path)}" para a Lixeira` : `${who} mandou ${items(e.count)} para a Lixeira`;
      case 'move':
        return e.path && e.count === 1
          ? `${who} moveu "${baseName(e.path)}" para ${whereIn(e.rootLabel, e.toPath ?? '')}`
          : `${who} moveu ${items(e.count)} para ${whereIn(e.rootLabel, e.toPath ?? '')}`;
      case 'rename':
        return `${who} renomeou "${baseName(e.path)}" para "${baseName(e.toPath)}"`;
      case 'mkdir':
        return `${who} criou a pasta "${baseName(e.path)}"`;
      case 'outboxDownload':
        return `${who} começou a baixar "${baseName(e.path)}", enviado pelo PC`;
      case 'outboxDone':
        return `${who} recebeu "${baseName(e.path)}", enviado pelo PC`;
      case 'outboxDecline':
        return `${who} recusou "${baseName(e.path)}", enviado pelo PC`;
      default:
        return `${who} usou as pastas liberadas`;
    }
  }

  function auditWhen(iso: string): string {
    const d = new Date(iso);
    const now = new Date();
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const diff = Math.round((day(now) - day(d)) / 86_400_000);
    if (diff === 0) return hm;
    if (diff === 1) return 'ontem';
    return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function rootCard(r: FsRootUiView): string {
    const icon = /^[A-Za-z]:\\?$/.test(r.absPath) || /^\\\\[^\\]+\\[^\\]+\\?$/.test(r.absPath) ? 'ph-hard-drives' : 'ph-folder';
    const notes: string[] = [];
    if (!r.available) notes.push('<span class="fs-note"><i class="ph ph-plugs"></i>Indisponível: unidade desconectada</span>');
    else if (!r.trashAvailable) notes.push('<span class="fs-note"><i class="ph ph-trash-simple"></i>Sem Lixeira: o celular não pode apagar aqui</span>');
    const meta = [r.absPath, r.drive && !r.absPath.startsWith(r.drive) ? r.drive : null, r.freeBytes != null ? `${comma(r.freeBytes / 1e9)} GB livres` : null].filter(Boolean).join(' · ');
    return `
      <div class="card-row fs-root ${r.available ? '' : 'off'}">
        <i class="ph ${icon} phone-icon"></i>
        <span class="card-text">
          <span class="t">${esc(r.label)}</span>
          <span class="s selectable" title="${esc(r.absPath)}">${esc(meta)}</span>
          ${notes.join('')}
        </span>
        <span class="fs-root-actions">
          <button type="button" class="btn btn-ghost" data-action="fs-open" data-id="${esc(r.id)}" title="Abrir a pasta" aria-label="Abrir a pasta"><i class="ph ph-arrow-square-out"></i></button>
          <button type="button" class="btn btn-ghost" data-action="fs-rename" data-id="${esc(r.id)}">Renomear</button>
          <button type="button" class="btn btn-ghost" data-action="fs-remove" data-id="${esc(r.id)}">Remover</button>
        </span>
      </div>`;
  }

  // ------------------------------------------------------------------ unidades deste PC (§10.13 [2026-11-06])

  const DRIVE_ICONS: Record<FsDriveUiView['kind'], string> = {
    fixed: 'ph-hard-drive',
    removable: 'ph-usb',
    network: 'ph-network',
    cdrom: 'ph-disc',
    other: 'ph-hard-drive',
  };

  function plural(n: number, one: string, many: string): string {
    return `${n} ${n === 1 ? one : many}`;
  }

  function driveCard(d: FsDriveUiView): string {
    const space =
      d.freeBytes != null ? (d.totalBytes ? `${fmtSize(d.freeBytes)} livres de ${fmtSize(d.totalBytes)}` : `${fmtSize(d.freeBytes)} livres`) : null;
    const sub = [d.kindLabel, d.system ? 'tem o Windows' : null, space].filter(Boolean).join(' · ');
    const tags: string[] = [];
    if (d.wholeRootId) tags.push('<span class="fs-tag fs-tag-on"><i class="ph ph-check-circle"></i>Liberada inteira</span>');
    else if (d.rootsInside) tags.push(`<span class="fs-tag">${esc(plural(d.rootsInside, 'pasta liberada', 'pastas liberadas'))}</span>`);
    const notes = d.trashAvailable ? '' : '<span class="fs-note"><i class="ph ph-trash-simple"></i>Sem Lixeira: o celular não pode apagar aqui</span>';
    const actions = d.wholeRootId
      ? ''
      : `${d.canAddWhole ? `<button type="button" class="btn btn-ghost" data-action="fs-drive-whole" data-id="${esc(d.id)}" ${busy ? 'disabled' : ''}>Liberar inteira</button>` : ''}
         <button type="button" class="btn btn-ghost" data-action="fs-drive-choose" data-id="${esc(d.id)}" ${busy ? 'disabled' : ''}>Escolher pasta…</button>`;
    return `
      <div class="card-row fs-drive" data-drive="${esc(d.id)}">
        <i class="ph ${DRIVE_ICONS[d.kind] ?? 'ph-hard-drive'} phone-icon"></i>
        <span class="card-text">
          <span class="t">${esc(d.canAddWhole ? d.label : d.name)}${tags.join('')}</span>
          <span class="s tnum" title="${esc(d.path)}">${esc(sub)}</span>
          ${notes}
        </span>
        <span class="fs-root-actions">${actions}</span>
      </div>`;
  }

  function drivesSection(s: UiState): string {
    const drives = s.fs.drives ?? [];
    const body = drives.length
      ? drives.map(driveCard).join('')
      : `<p class="muted small">${drivesLoaded ? 'Nenhuma unidade encontrada. Use "Adicionar pasta".' : 'Procurando as unidades…'}</p>`;
    return `<span class="section-label gap">Unidades deste PC</span>${body}`;
  }

  /** Aviso de unidade inteira (§10.13): o que o celular vai ver, o que continua bloqueado e as pastas trocadas. */
  function confirmAddDialog(c: FsAddConfirm): { title: string; body: string; confirm: string } {
    const drive = c.drive ?? c.path;
    const parts: string[] = [];
    if (c.wholeDrive && c.systemDrive) {
      parts.push(`<p class="fs-confirm-lead">O celular vai ver todo o disco ${esc(drive)}, menos as pastas do sistema e de programas.</p>`);
      parts.push(
        '<p class="fs-confirm-blocked"><i class="ph ph-shield-check"></i><span>Continuam bloqueados: Windows, Arquivos de Programas, ProgramData, dados de programas (AppData), as pastas de outros usuários deste PC, chaves e senhas, e os dados do Arkivo.</span></p>',
      );
    } else if (c.wholeDrive) {
      parts.push(`<p class="fs-confirm-lead">O celular vai ver todos os arquivos do disco ${esc(drive)}, menos as pastas do sistema que houver nele.</p>`);
    }
    parts.push('<p class="muted">Pelo celular dá para ver, baixar, enviar, renomear, mover e apagar. O que for apagado vai para a Lixeira do PC.</p>');
    if (c.replaces.length) {
      const names = c.replaces.map((r) => `"${esc(r.label)}"`).join(', ');
      parts.push(
        `<p class="fs-confirm-replace"><i class="ph ph-swap"></i><span>${c.replaces.length === 1 ? 'Já está liberada' : 'Já estão liberadas'} neste disco: ${names}. ${c.replaces.length === 1 ? 'Ela vai ser trocada' : 'Elas vão ser trocadas'} pelo disco inteiro e ${c.replaces.length === 1 ? 'passa' : 'passam'} a aparecer no celular dentro de "${esc(c.label)}".</span></p>`,
      );
    }
    return {
      title: c.wholeDrive ? `Liberar o disco ${esc(drive)} inteiro?` : 'Liberar esta pasta?',
      body: `<div class="fs-confirm">${parts.join('')}</div>`,
      confirm: `<button type="button" class="btn btn-primary" data-action="fs-confirm-add-ok" ${busy ? 'disabled' : ''}>${c.replaces.length ? 'Trocar e liberar' : 'Liberar o disco inteiro'}</button>`,
    };
  }

  /** Resultado de "Adicionar pasta", "Liberar inteira" e "Escolher pasta…": confirmação, recusa ou pronto. */
  function fsAddResult(r: FsAddActionResult): void {
    if (r.confirm) {
      dialog = { kind: 'fs-confirm-add', confirm: r.confirm };
      fsError = null;
      return;
    }
    fsError = r.ok || r.canceled ? null : (r.error ?? null);
  }

  /** A tela "Pastas liberadas" aberta e visível: enumera as unidades de novo (pen drive conectado aparece sozinho). */
  function refreshDrives(): void {
    if (state?.phase !== 'active' || view !== 'pastas' || drivesRefreshing) return;
    drivesRefreshing = true;
    void bridge
      .fsRefreshDrives()
      .catch(() => undefined)
      .finally(() => {
        drivesRefreshing = false;
        drivesLoaded = true;
        render();
      });
  }

  function fsView(s: UiState): string {
    const fs = s.fs;
    const roots = fs.roots.length
      ? fs.roots.map(rootCard).join('')
      : `<div class="card-row"><i class="ph ph-folder-dashed phone-icon"></i><span class="card-text"><span class="t">Nenhuma pasta liberada</span><span class="s">Escolha as pastas que o celular pode ver.</span></span></div>`;
    const audit = fs.audit.length
      ? `<ul class="fs-audit">${fs.audit
          .slice(0, 100)
          .map(
            (e) => `<li>
              <span class="fs-audit-text">${esc(auditText(e))}${e.result === 'ok' ? '' : ' <span class="fs-fail">· não deu certo</span>'}</span>
              <span class="fs-tag">${e.via === 'remote' ? 'Pela internet' : 'Na rede de casa'}</span>
              <span class="fs-when tnum">${esc(auditWhen(e.at))}</span>
            </li>`,
          )
          .join('')}</ul>`
      : '<p class="muted small">Nada por aqui ainda.</p>';
    return `
      <section class="settings fs-view">
        <span class="settings-title">Pastas liberadas</span>
        <p class="fs-lead">O celular pode ver, baixar, enviar, renomear, mover e apagar arquivos nestas pastas. O que for apagado vai para a Lixeira do PC.</p>
        <button type="button" class="check" data-action="fs-toggle" role="switch" aria-checked="${fs.enabled}" ${busy ? 'disabled' : ''}>
          <i class="ph ${fs.enabled ? 'ph-toggle-right' : 'ph-toggle-left'} fs-switch"></i>Acesso pelo celular</button>
        ${fs.enabled ? '' : '<span class="muted small">O celular não vê nenhuma pasta.</span>'}
        <span class="section-label gap">Pastas</span>
        ${roots}
        <div class="fs-add-row">
          <button type="button" class="btn btn-secondary" data-action="fs-add" ${busy ? 'disabled' : ''}><i class="ph ph-plus"></i>Adicionar pasta</button>
          ${fsError ? `<span class="error-text"><i class="ph ph-warning-circle"></i>${esc(fsError)}</span>` : ''}
        </div>
        ${drivesSection(s)}
        <span class="warn-line fs-shield"><i class="ph ph-shield-check"></i>Pastas do sistema, de programas, de outros usuários e com chaves e senhas nunca são liberadas, nem dentro de uma pasta ou unidade escolhida.</span>
        <div class="fs-audit-head">
          <span class="section-label">O que o celular fez</span>
          ${fs.audit.length ? '<button type="button" class="btn btn-ghost" data-action="fs-clear-audit">Limpar histórico</button>' : ''}
        </div>
        ${audit}
      </section>`;
  }

  // ------------------------------------------------------------------ enviar para o celular (§11)

  function canReceive(p: UiState['phones'][number]): boolean {
    return !!p.capabilities?.includes(FS_PUSH);
  }

  function outboxStateText(i: OutboxUiItem): { text: string; tone: string; icon: string } {
    switch (i.state) {
      case 'waiting':
        return { text: 'Aguardando o celular', tone: '', icon: 'ph-clock' };
      case 'downloading':
        return { text: `Baixando ${Math.floor((i.progress ?? 0) * 100)}%`, tone: 'on', icon: 'ph-download-simple' };
      case 'delivered':
        return { text: 'Entregue', tone: 'ok', icon: 'ph-check-circle' };
      case 'declined':
        return { text: 'Recusado', tone: 'off', icon: 'ph-x-circle' };
      case 'changed':
        return { text: 'Arquivo mudou', tone: 'warn', icon: 'ph-warning' };
      case 'expired':
        return { text: 'Expirou', tone: 'off', icon: 'ph-hourglass-simple-low' };
      default:
        return { text: 'Falhou', tone: 'warn', icon: 'ph-warning-circle' };
    }
  }

  function outboxRow(i: OutboxUiItem, s: UiState): string {
    const st = outboxStateText(i);
    const active = i.state === 'waiting' || i.state === 'downloading';
    const phone = s.phones.find((p) => p.id === i.phoneId)?.name || i.phoneName || 'Celular';
    const days = Math.ceil((Date.parse(i.expiresAt) - Date.now()) / 86_400_000);
    const sub = [
      fmtSize(i.size),
      s.phones.length > 1 ? phone : null,
      i.state === 'waiting' ? (days <= 1 ? 'espera por menos de 1 dia' : `espera por mais ${days} dias`) : null,
      i.state === 'downloading' ? (i.via === 'remote' ? 'Pela internet' : 'Na rede de casa') : null,
      i.state === 'changed' ? 'Envie de novo' : null,
      i.reason,
    ]
      .filter(Boolean)
      .join(' · ');
    // `<progress>` em vez de largura por `style`: a CSP da janela não aceita estilo inline.
    const bar = i.state === 'downloading' ? `<progress class="ob-bar" max="100" value="${Math.floor((i.progress ?? 0) * 100)}"></progress>` : '';
    return `
      <div class="card-row ob-row" data-state="${esc(i.state)}">
        <i class="ph ph-file phone-icon"></i>
        <span class="card-text">
          <span class="t" title="${esc(i.folder)}">${esc(i.name)}</span>
          <span class="s tnum">${esc(sub)}</span>
          ${bar}
        </span>
        <span class="ob-state ${st.tone} tnum"><i class="ph ${st.icon}"></i>${esc(st.text)}</span>
        <button type="button" class="btn btn-ghost" data-action="outbox-cancel" data-id="${esc(i.id)}">${active ? 'Cancelar' : 'Remover'}</button>
      </div>`;
  }

  /** Aviso quando o celular não pode receber agora (§11): nunca falha em silêncio. */
  function outboxBlockText(s: UiState): string | null {
    if (!s.phones.length) return 'Nenhum celular encontrado. A lista atualiza quando o PC conecta ao servidor.';
    if (!s.phones.some(canReceive)) return 'Atualize o Arkivo no celular para ele poder receber arquivos do PC.';
    return null;
  }

  function outboxView(s: UiState): string {
    const block = outboxBlockText(s);
    const rows = s.outbox.map((i) => outboxRow(i, s)).join('');
    const rejected = outboxRejected.length
      ? `<ul class="ob-rejected">${outboxRejected
          .slice(0, 8)
          .map((r) => `<li><i class="ph ph-warning-circle"></i><span><strong>${esc(r.name || 'Arquivo')}</strong>: ${esc(r.reason)}</span></li>`)
          .join('')}${outboxRejected.length > 8 ? `<li><span>e mais ${outboxRejected.length - 8}</span></li>` : ''}</ul>`
      : '';
    return `
      <section class="settings ob-view">
        <span class="settings-title">Enviar para o celular</span>
        <p class="fs-lead">O arquivo espera aqui no PC por até 7 dias e nada fica guardado no servidor. <strong>O PC precisa estar ligado</strong> para o celular baixar, e nada é gravado no celular sem o toque de quem está com ele.</p>
        <div class="ob-drop ${block ? 'off' : ''}">
          <i class="ph ph-paper-plane-tilt"></i>
          <span class="ob-drop-text">${block ? 'Envio indisponível agora' : 'Arraste arquivos para cá'}</span>
          <button type="button" class="btn btn-primary" data-action="outbox-pick" ${block || busy ? 'disabled' : ''}>Escolher arquivos</button>
          <span class="muted small">Só arquivos, até 2 GB cada.</span>
        </div>
        ${block ? `<span class="note ob-block" role="status"><i class="ph ph-info"></i>${esc(block)}</span>` : ''}
        ${outboxError ? `<span class="error-text"><i class="ph ph-warning-circle"></i>${esc(outboxError)}</span>` : ''}
        ${rejected}
        ${rows ? `<span class="section-label gap">Arquivos</span>${rows}` : ''}
      </section>`;
  }

  function outboxResult(r: OutboxActionResult): void {
    outboxError = r.ok || r.canceled ? null : (r.error ?? 'Não foi possível enviar.');
    outboxRejected = r.rejected ?? [];
  }

  /** Só um celular: vai para ele. Mais de um: o usuário escolhe. */
  function outboxSend(files: File[] | null): void {
    const s = state;
    if (!s) return;
    const block = outboxBlockText(s);
    if (block) {
      outboxRejected = [];
      outboxError = block;
      render();
      return;
    }
    if (s.phones.length > 1) {
      dialog = { kind: 'outbox-phone', files };
      render();
      return;
    }
    outboxSendTo(s.phones[0].id, files);
  }

  function outboxSendTo(phoneId: string, files: File[] | null): void {
    void run(async () => {
      const r = files ? await bridge.outboxDrop(files, phoneId) : await bridge.outboxPick(phoneId);
      outboxResult(r);
      return r;
    });
  }

  function dialogHtml(s: UiState): string {
    if (!dialog) return '';
    let title: string;
    let body: string;
    let confirm: string;
    if (dialog.kind === 'outbox-phone') {
      title = 'Para qual celular?';
      body = `<div class="ob-phones">${s.phones
        .map((p) => {
          const able = canReceive(p);
          return `<button type="button" class="btn btn-secondary ob-phone" data-action="outbox-phone" data-id="${esc(p.id)}" ${able && !busy ? '' : 'disabled'}>
            <i class="ph ph-device-mobile"></i><span>${esc(p.name || 'Celular')}${able ? '' : '<span class="muted small"> · precisa atualizar o app</span>'}</span></button>`;
        })
        .join('')}</div>`;
      confirm = '';
    } else if (dialog.kind === 'fs-confirm-add') {
      ({ title, body, confirm } = confirmAddDialog(dialog.confirm));
    } else if (dialog.kind === 'logout') {
      title = 'Sair da conta neste PC?';
      body = `O PC para de receber backups e o celular vai mostrar que ele foi desconectado. Os arquivos já salvos continuam na pasta ${esc(s.storageDir ?? '')}.`;
      confirm = `<button type="button" class="btn btn-primary" data-action="logout" ${busy ? 'disabled' : ''}>Sair</button>`;
    } else if (dialog.kind === 'fs-remove') {
      title = `Parar de liberar "${esc(dialog.label)}"?`;
      body = 'Os arquivos continuam no PC.';
      confirm = `<button type="button" class="btn btn-primary" data-action="fs-remove-confirm" ${busy ? 'disabled' : ''}>Parar de liberar</button>`;
    } else {
      title = 'Renomear pasta liberada';
      body = `<label class="fs-rename"><span class="muted">Nome que aparece no celular</span>
        <input id="fs-rename-input" class="input" type="text" maxlength="64" value="${esc(dialog.label)}" data-action="fs-rename-input" />
        ${fsError ? `<span class="error-text"><i class="ph ph-warning-circle"></i>${esc(fsError)}</span>` : ''}</label>`;
      confirm = `<button type="button" class="btn btn-primary" data-action="fs-rename-confirm" ${busy ? 'disabled' : ''}>Salvar</button>`;
    }
    return `
      <div class="dialog-backdrop" data-action="close-dialog">
        <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
          <h3 class="dialog-title" id="dlg-title">${title}</h3>
          <div class="dialog-body">${body}</div>
          <div class="dialog-actions">
            <button type="button" class="btn btn-ghost" data-action="close-dialog">Cancelar</button>
            ${confirm}
          </div>
        </div>
      </div>`;
  }

  function titlebarStatus(s: UiState): string {
    if (s.phase !== 'active' || !s.account) return '';
    return `<span class="titlebar-status"><span class="dot sm ${s.serverConnected ? '' : 'off'}"></span>Conectado como ${esc(s.account.email || s.account.name || s.account.handle)}</span>`;
  }

  // ------------------------------------------------------------------ render

  function patch(id: string, html: string): boolean {
    if (rendered[id] === html) return false;
    const el = document.getElementById(id);
    if (!el) return false;
    rendered[id] = html;
    el.innerHTML = html;
    return true;
  }

  const ACTIVE_FRAME = `<div class="active"><nav class="sidebar" id="sidebar-slot"></nav><div class="active-main" id="active-main"></div></div>`;

  function render(): void {
    const s = state;
    if (!s) return;
    patch('titlebar-status', titlebarStatus(s));
    let main = ACTIVE_FRAME;
    if (s.phase === 'folder') main = folderStep(s);
    else if (s.phase === 'pairing') main = qrStep(s);
    else if (s.phase === 'updateRequired') main = updateStep(s);
    else if (s.phase === 'loading') main = '';
    if (patch('view', main)) {
      // Moldura recriada: as regiões internas precisam ser desenhadas de novo.
      delete rendered['sidebar-slot'];
      delete rendered['active-main'];
    }
    if (s.phase === 'active') {
      // Só as regiões que mudaram são redesenhadas (mantém foco/hover nos botões).
      patch('sidebar-slot', sidebar(s));
      patch('active-main', view === 'config' ? settingsView(s) : view === 'pastas' ? fsView(s) : view === 'enviar' ? outboxView(s) : activityView(s));
    } else {
      dialog = null;
    }
    if (patch('dialog', dialogHtml(s)) && dialog?.kind === 'fs-rename') {
      const input = document.getElementById('fs-rename-input') as HTMLInputElement | null;
      if (input && document.activeElement !== input) {
        // O diálogo foi recriado (ex.: ocupado/erro): mantém o que já foi digitado.
        input.value = renameDraft;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
      }
    }
  }

  async function renameRoot(): Promise<void> {
    if (dialog?.kind !== 'fs-rename') return;
    const id = dialog.id;
    await run(async () => {
      const r = await bridge.fsRenameRoot(id, renameDraft);
      if (r.ok) {
        dialog = null;
        fsError = null;
      } else fsError = r.error ?? 'Não foi possível renomear.';
      return r;
    });
  }

  // ------------------------------------------------------------------ ações

  async function run(fn: () => Promise<{ ok: boolean; error?: string }>): Promise<void> {
    if (busy) return;
    busy = true;
    render();
    try {
      await fn();
    } finally {
      busy = false;
      render();
    }
  }

  document.addEventListener('click', (ev) => {
    const target = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!target || !state) return;
    const action = target.dataset.action;
    // Clique no fundo do diálogo fecha; clique dentro do cartão não.
    if (action === 'close-dialog' && target.classList.contains('dialog-backdrop') && ev.target !== target) return;
    switch (action) {
      case 'choose-folder':
        void run(() => bridge.chooseFolder());
        break;
      case 'select-link':
        (target as HTMLInputElement).select();
        break;
      case 'copy-link': {
        const link = state.pairing?.link;
        if (!link) break;
        void bridge.copyText(link).then((r) => {
          if (r.ok) {
            copiedAt = Date.now();
            render();
            setTimeout(render, 2600);
          }
        });
        break;
      }
      case 'toggle-autostart':
        void run(() => bridge.setAutostart(!state!.autostart));
        break;
      case 'continue':
        void run(() => bridge.continuePairing());
        break;
      case 'nav':
        view = target.dataset.view === 'config' ? 'config' : target.dataset.view === 'pastas' ? 'pastas' : target.dataset.view === 'enviar' ? 'enviar' : 'atividade';
        fsError = null;
        outboxError = null;
        outboxRejected = [];
        if (state.error) void bridge.clearError();
        render();
        refreshDrives();
        break;
      case 'fs-toggle':
        void run(() => bridge.fsSetEnabled(!state!.fs.enabled));
        break;
      case 'fs-add':
        void run(async () => {
          const r = await bridge.fsAddRoot();
          fsAddResult(r);
          return r;
        });
        break;
      case 'fs-drive-whole':
      case 'fs-drive-choose': {
        const id = target.dataset.id;
        if (!id) break;
        void run(async () => {
          const r = action === 'fs-drive-whole' ? await bridge.fsAddDrive(id) : await bridge.fsChooseInDrive(id);
          fsAddResult(r);
          return r;
        });
        break;
      }
      case 'fs-confirm-add-ok': {
        if (dialog?.kind !== 'fs-confirm-add') break;
        const token = dialog.confirm.token;
        void run(async () => {
          const r = await bridge.fsConfirmAdd(token);
          dialog = null;
          fsError = r.ok ? null : (r.error ?? 'Não foi possível liberar.');
          return r;
        });
        break;
      }
      case 'fs-open':
        if (target.dataset.id) void bridge.fsOpenRoot(target.dataset.id);
        break;
      case 'fs-remove':
      case 'fs-rename': {
        const root = state.fs.roots.find((r) => r.id === target.dataset.id);
        if (!root) break;
        fsError = null;
        renameDraft = root.label;
        dialog = action === 'fs-remove' ? { kind: 'fs-remove', id: root.id, label: root.label } : { kind: 'fs-rename', id: root.id, label: root.label };
        render();
        break;
      }
      case 'fs-remove-confirm': {
        if (dialog?.kind !== 'fs-remove') break;
        const id = dialog.id;
        void run(async () => {
          const r = await bridge.fsRemoveRoot(id);
          dialog = null;
          return r;
        });
        break;
      }
      case 'fs-rename-confirm':
        void renameRoot();
        break;
      case 'fs-clear-audit':
        void run(() => bridge.fsClearAudit());
        break;
      case 'outbox-pick':
        outboxSend(null);
        break;
      case 'outbox-phone': {
        if (dialog?.kind !== 'outbox-phone' || !target.dataset.id) break;
        const files = dialog.files;
        dialog = null;
        outboxSendTo(target.dataset.id, files);
        break;
      }
      case 'outbox-cancel':
        if (target.dataset.id) void bridge.outboxCancel(target.dataset.id);
        break;
      case 'open-folder':
        void bridge.openFolder();
        break;
      case 'unpair':
        view = 'atividade';
        void run(() => bridge.unpair());
        break;
      case 'ask-logout':
        dialog = { kind: 'logout' };
        render();
        break;
      case 'close-dialog':
        dialog = null;
        fsError = null;
        render();
        break;
      case 'logout':
        view = 'atividade';
        void run(async () => {
          const r = await bridge.logout();
          dialog = null;
          return r;
        });
        break;
    }
  });

  document.addEventListener('input', (ev) => {
    const t = ev.target as HTMLInputElement;
    if (t?.dataset?.action === 'fs-rename-input') renameDraft = t.value;
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && dialog) {
      dialog = null;
      fsError = null;
      render();
    } else if (ev.key === 'Enter' && dialog?.kind === 'fs-rename') {
      ev.preventDefault();
      void renameRoot();
    }
  });

  // Arrastar arquivos para a janela (§11). Sem isto, soltar um arquivo faria o Chromium tentar abri-lo.
  const hasFiles = (ev: DragEvent) => !!ev.dataTransfer && [...ev.dataTransfer.types].includes('Files');
  let dragDepth = 0;
  const setDragging = (on: boolean) => document.body.classList.toggle('dragging-files', on && state?.phase === 'active');
  document.addEventListener('dragenter', (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    dragDepth++;
    setDragging(true);
  });
  document.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = hasFiles(ev) && state?.phase === 'active' ? 'copy' : 'none';
  });
  document.addEventListener('dragleave', (ev) => {
    if (!hasFiles(ev)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDragging(false);
  });
  document.addEventListener('drop', (ev) => {
    ev.preventDefault();
    dragDepth = 0;
    setDragging(false);
    if (state?.phase !== 'active' || dialog || busy) return;
    const files = [...(ev.dataTransfer?.files ?? [])];
    if (!files.length) return;
    view = 'enviar';
    outboxError = null;
    outboxRejected = [];
    outboxSend(files);
    render();
  });

  // Contagem regressiva do QR e textos relativos ("há 3 min").
  setInterval(() => {
    if (!state) return;
    if (state.phase === 'pairing') {
      const el = document.getElementById('qr-left');
      if (el) el.textContent = qrLeft(state);
    }
  }, 250);
  setInterval(() => render(), 30_000);
  // "Unidades deste PC": a cada ~10 s com a tela aberta e ao voltar para a janela (pen drive conectado aparece sozinho).
  setInterval(() => {
    if (document.visibilityState === 'visible') refreshDrives();
  }, 10_000);
  window.addEventListener('focus', () => refreshDrives());

  bridge.onState((s) => {
    state = s;
    render();
  });
  void bridge.getState().then((s) => {
    state = s;
    render();
  });
})();
