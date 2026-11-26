const MONO =
  'var(--ds-font-family-code,ui-monospace,"Cascadia Code",SFMono-Regular,Menlo,Consolas,monospace)';

export const CSS = `
/* The active Memory view shares the host's scrollport with its resident composer. */
[data-conversation-scroll]:has(> [data-slot="conversation.session"] [data-cc-memory-view="1"])
  > [data-composer-seat] [data-composer-card]{display:none}
.ccm-root{
  --ccm-fg:var(--dsw-alias-label-primary,#0f1115);
  --ccm-fg2:var(--dsw-alias-label-secondary,#575c63);
  --ccm-fg3:var(--dsw-alias-label-tertiary,#8a8f96);
  --ccm-surface:var(--dsw-alias-bg-layer-1,#fff);
  --ccm-input:var(--dsw-alias-bg-base,#fff);
  --ccm-line:var(--dsw-alias-border-l1,rgba(0,0,0,.07));
  --ccm-line2:var(--dsw-alias-border-l2,rgba(0,0,0,.12));
  --ccm-hover:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06));
  --ccm-active:var(--dsw-alias-interactive-bg-active,rgba(38,49,72,.1));
  --ccm-accent:var(--dsw-alias-trajectory-accent,#3b82f6);
  --ccm-ok:var(--dsw-alias-state-success-primary,#22c55e);
  --ccm-ok-fg:color-mix(in srgb,var(--dsw-alias-state-success-primary,#22c55e) 82%,#000);
  --ccm-warn:var(--dsw-alias-state-warn-primary,#f59e0b);
  --ccm-warn-fg:var(--dsw-alias-state-warn-label,#b45309);
  --ccm-danger:var(--dsw-alias-state-error-primary,#dc2626);
  --ccm-strong:var(--dsw-alias-button-primary-fill,#0f1115);
  --ccm-on-strong:var(--dsw-alias-label-primary-inverted,#fff);
  --ccm-link:var(--dsw-alias-link,var(--ccm-accent));
  position:relative;flex:1;min-height:0;height:100%;display:flex;flex-direction:column;overflow:hidden;
  font-family:inherit;font-size:13px;line-height:1.55;color:var(--ccm-fg);
  background:var(--dsw-alias-bg-module-platform,#f5f6f7);-webkit-font-smoothing:antialiased}
.ccm-root *,.ccm-root *::before,.ccm-root *::after{box-sizing:border-box}
.ccm-root button,.ccm-root input,.ccm-root textarea{font:inherit;color:inherit}
.ccm-root :focus-visible{outline:2px solid var(--ccm-accent);outline-offset:2px}
.ccm-mono{font-family:${MONO}}
.ccm-spacer{flex:1}
.ccm-muted{color:var(--ccm-fg3)}

.ccm-headbar{flex:none;container-type:inline-size;border-bottom:1px solid var(--ccm-line)}
.ccm-scroll{flex:1;min-height:0;overflow:auto;container-type:inline-size}
.ccm-shell{max-width:1080px;margin:0 auto;padding:0 24px}
.ccm-scroll>.ccm-shell{padding:18px 24px 24px;display:flex;flex-direction:column;gap:16px}
.ccm-head{display:flex;align-items:flex-start;gap:12px;padding:18px 0 4px}
.ccm-head-main{flex:1;min-width:0}
.ccm-title{display:flex;align-items:baseline;gap:10px;margin:0;font-size:19px;font-weight:650;letter-spacing:-.015em;line-height:1.3}
.ccm-title-sub{font-size:12.5px;font-weight:500;color:var(--ccm-fg3);letter-spacing:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ccm-load{display:flex;align-items:center;gap:7px;margin-top:5px;font-size:12.5px;color:var(--ccm-fg2)}
.ccm-load>svg{flex:none;color:var(--ccm-fg3)}
.ccm-load[data-tone=warn]>svg{color:var(--ccm-warn)}
.ccm-load-extra{color:var(--ccm-fg3)}
.ccm-tabs{display:flex;gap:2px;margin:8px -4px 0;overflow-x:auto;scrollbar-width:none}
.ccm-tabs::-webkit-scrollbar{display:none}
.ccm-tab{position:relative;flex:none;display:inline-flex;align-items:center;gap:7px;height:38px;padding:0 12px;border:0;background:transparent;
  color:var(--ccm-fg2);font-size:13px;font-weight:550;cursor:pointer;border-radius:8px 8px 0 0;transition:color .15s,background .15s}
.ccm-tab:hover{color:var(--ccm-fg);background:var(--ccm-hover)}
.ccm-tab[aria-selected=true]{color:var(--ccm-fg)}
.ccm-tab[aria-selected=true]::after{content:'';position:absolute;left:10px;right:10px;bottom:-1px;height:2px;border-radius:2px;background:var(--ccm-accent)}
.ccm-tab-n{font-size:11.5px;font-weight:500;color:var(--ccm-fg3);font-variant-numeric:tabular-nums}
.ccm-badge-dot{width:7px;height:7px;border-radius:99px;background:var(--ccm-warn)}

.ccm-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 13px;border-radius:8px;
  border:1px solid var(--ccm-line2);background:var(--ccm-surface);font-size:13px;font-weight:500;cursor:pointer;white-space:nowrap;
  transition:background .15s,border-color .15s,opacity .15s,color .15s}
.ccm-btn:hover:not(:disabled){background:var(--ccm-hover)}
.ccm-btn:disabled{opacity:.45;cursor:not-allowed}
.ccm-btn svg{flex:none}
.ccm-btn-primary{background:var(--ccm-strong);border-color:transparent;color:var(--ccm-on-strong)!important}
.ccm-btn-primary:hover:not(:disabled){background:var(--ccm-strong);opacity:.86}
.ccm-btn-ghost{border-color:transparent;background:transparent;color:var(--ccm-fg2)!important}
.ccm-btn-danger{color:var(--ccm-danger)!important}
.ccm-btn-sm{height:28px;padding:0 10px;font-size:12.5px;border-radius:7px}
.ccm-icon-btn{width:32px;padding:0}
.ccm-btn-sm.ccm-icon-btn{width:28px}
.ccm-armed{background:var(--ccm-warn)!important;border-color:transparent!important;color:#1b1206!important;opacity:1!important}
.ccm-armed-danger{background:var(--ccm-danger)!important;border-color:transparent!important;color:#fff!important;opacity:1!important}
.ccm-spinning svg{animation:ccm-spin .8s linear infinite}
.ccm-link{display:inline;padding:0;border:0;background:transparent;color:var(--ccm-link);cursor:pointer;text-decoration:underline;
  text-decoration-color:color-mix(in srgb,var(--ccm-link) 40%,transparent);text-underline-offset:2px}
.ccm-link:hover{text-decoration-color:currentColor}

.ccm-banner{display:flex;align-items:center;gap:10px;padding:10px 12px 10px 14px;border-radius:10px;font-size:12.5px;color:var(--ccm-fg2);
  background:color-mix(in srgb,var(--ccm-warn) 10%,var(--ccm-surface));border:1px solid color-mix(in srgb,var(--ccm-warn) 28%,transparent)}
.ccm-banner-error{background:color-mix(in srgb,var(--ccm-danger) 8%,var(--ccm-surface));border-color:color-mix(in srgb,var(--ccm-danger) 25%,transparent)}
.ccm-banner>svg{flex:none;color:var(--ccm-warn)}
.ccm-banner-error>svg{color:var(--ccm-danger)}
.ccm-banner-text{flex:1;min-width:0}

.ccm-card{background:var(--ccm-surface);border:1px solid var(--ccm-line);border-radius:12px;min-width:0}
.ccm-card-head{display:flex;align-items:center;gap:8px;padding:14px 16px 10px;flex-wrap:wrap}
.ccm-card-title{font-size:14px;font-weight:620}
.ccm-card-sub{font-size:12px;color:var(--ccm-fg3)}
.ccm-card-text{margin:-4px 16px 12px;font-size:12.5px;color:var(--ccm-fg2)}
.ccm-card-body{padding:0 16px 16px}
.ccm-section{display:flex;align-items:baseline;gap:8px;margin:4px 2px -6px}
.ccm-section-title{font-size:12px;font-weight:650;color:var(--ccm-fg2);text-transform:none}
.ccm-pill{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 8px;border-radius:99px;font-size:11px;font-weight:600;
  background:var(--ccm-hover);color:var(--ccm-fg2);white-space:nowrap}
.ccm-pill-warn{background:color-mix(in srgb,var(--ccm-warn) 18%,transparent);color:var(--ccm-warn-fg)}
.ccm-pill-ok{background:color-mix(in srgb,var(--ccm-ok) 15%,transparent);color:var(--ccm-ok-fg)}
.ccm-pill-accent{background:color-mix(in srgb,var(--ccm-accent) 13%,transparent);color:var(--ccm-accent)}
.ccm-pill-danger{background:color-mix(in srgb,var(--ccm-danger) 12%,transparent);color:var(--ccm-danger)}
.ccm-dot{width:8px;height:8px;border-radius:99px;flex:none;background:var(--ccm-type,var(--ccm-fg3))}
.ccm-tag{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border-radius:6px;font-size:11.5px;font-weight:600;
  color:var(--ccm-type);background:color-mix(in srgb,var(--ccm-type) 12%,transparent)}
.ccm-tag .ccm-dot{width:6px;height:6px}
.ccm-trust{display:inline-flex;align-items:center;gap:4px;height:20px;padding:0 7px;border-radius:99px;font-size:11px;font-weight:600;white-space:nowrap;
  color:var(--ccm-fg2);background:var(--ccm-hover)}
.ccm-trust svg{flex:none}
.ccm-trust[data-trust=verified]{color:var(--ccm-ok-fg);background:color-mix(in srgb,var(--ccm-ok) 14%,transparent)}
.ccm-trust[data-trust=changed]{color:var(--ccm-warn-fg);background:color-mix(in srgb,var(--ccm-warn) 16%,transparent)}
.ccm-trust[data-trust=stale]{color:var(--ccm-fg3);background:var(--ccm-hover);text-decoration:line-through;text-decoration-color:transparent}

.ccm-toolbar{display:flex;align-items:center;gap:8px}
.ccm-search{position:relative;flex:1;min-width:0;display:block}
.ccm-search-icon{position:absolute;left:12px;top:50%;transform:translateY(-50%);display:flex;color:var(--ccm-fg3);pointer-events:none}
.ccm-search .ccm-input{height:36px;padding-left:36px;padding-right:34px;border-radius:10px}
.ccm-search-clear{position:absolute;right:6px;top:50%;transform:translateY(-50%);display:flex;align-items:center;justify-content:center;
  width:24px;height:24px;border:0;border-radius:6px;background:transparent;color:var(--ccm-fg3);cursor:pointer}
.ccm-search-clear:hover{background:var(--ccm-hover);color:var(--ccm-fg)}
.ccm-input,.ccm-textarea{width:100%;border:1px solid var(--ccm-line2);border-radius:8px;background:var(--ccm-input);outline:none;
  transition:border-color .15s,box-shadow .15s}
.ccm-input{height:34px;padding:0 11px;font-size:13px}
.ccm-textarea{display:block;min-height:150px;padding:10px 12px;resize:vertical;font-family:${MONO};font-size:12.5px;line-height:1.65}
.ccm-input:focus,.ccm-textarea:focus{border-color:var(--ccm-accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--ccm-accent) 18%,transparent)}
.ccm-input::placeholder,.ccm-textarea::placeholder{color:var(--ccm-fg3)}
.ccm-input:disabled,.ccm-textarea:disabled{opacity:.6}
.ccm-checkline{display:flex;align-items:center;gap:8px;font-size:12.5px;color:var(--ccm-fg2);cursor:pointer}
.ccm-checkline input{width:15px;height:15px;margin:0;accent-color:var(--ccm-accent)}

.ccm-filters{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ccm-chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px;border-radius:99px;border:1px solid var(--ccm-line2);
  background:transparent;color:var(--ccm-fg2);font-size:12.5px;cursor:pointer;transition:background .15s,color .15s,border-color .15s}
.ccm-chip:hover{background:var(--ccm-hover);color:var(--ccm-fg)}
.ccm-chip[aria-pressed=true]{background:var(--ccm-strong);border-color:transparent;color:var(--ccm-on-strong)}
.ccm-chip-n{font-variant-numeric:tabular-nums;opacity:.55}
.ccm-seg{display:inline-flex;padding:2px;border-radius:8px;background:var(--ccm-hover);flex-wrap:wrap}
.ccm-seg button{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border:0;border-radius:6px;background:transparent;
  color:var(--ccm-fg2);font-size:12px;cursor:pointer;white-space:nowrap}
.ccm-seg button[aria-pressed=true]{background:var(--ccm-surface);color:var(--ccm-fg);box-shadow:0 0 0 1px var(--ccm-line)}
.ccm-seg-n{font-variant-numeric:tabular-nums;color:var(--ccm-fg3)}

.ccm-split{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;align-items:start}
.ccm-split.has-detail{grid-template-columns:minmax(260px,.85fr) minmax(0,1.35fr)}
.ccm-listpane{display:flex;flex-direction:column;gap:12px;min-width:0}
.ccm-rows{overflow:hidden}
.ccm-row{position:relative;display:flex;align-items:flex-start;gap:11px;width:100%;padding:12px 14px 12px 16px;border:0;border-top:1px solid var(--ccm-line);
  background:transparent;text-align:left;cursor:pointer;transition:background .12s}
.ccm-row:first-child{border-top:0}
.ccm-row:hover{background:var(--ccm-hover)}
.ccm-row[aria-current=true]{background:color-mix(in srgb,var(--ccm-accent) 8%,transparent);box-shadow:inset 3px 0 0 var(--ccm-accent)}
.ccm-row.is-stale .ccm-row-name{color:var(--ccm-fg2)}
.ccm-row>.ccm-dot{margin-top:6px}
.ccm-row-main{flex:1;min-width:0;display:block}
.ccm-row-name{display:block;font-size:13.5px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ccm-row-desc{display:-webkit-box;margin-top:2px;font-size:12.5px;color:var(--ccm-fg2);-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ccm-row-snippet{display:block;margin-top:5px;padding:4px 8px;border-radius:6px;font-size:12px;color:var(--ccm-fg2);background:var(--ccm-hover);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ccm-row-side{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:5px;margin-top:1px}
.ccm-row-time{font-size:11.5px;color:var(--ccm-fg3);white-space:nowrap;font-variant-numeric:tabular-nums}
.ccm-none{padding:28px 16px;text-align:center;font-size:12.5px;color:var(--ccm-fg3)}

.ccm-detail{position:sticky;top:0;display:flex;flex-direction:column;max-height:calc(var(--ccm-vh,100vh) - 36px);overflow:hidden}
.ccm-detail-bar{flex:none;display:flex;align-items:center;gap:6px;min-height:48px;padding:8px 10px 8px 12px;border-bottom:1px solid var(--ccm-line)}
.ccm-detail-body{min-height:0;overflow:auto;padding:18px 20px 20px}
.ccm-detail .ccm-form{min-height:0;overflow:auto}
.ccm-detail-tags{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ccm-detail-name{margin:10px 0 4px;font-size:18px;font-weight:650;letter-spacing:-.01em;line-height:1.35;overflow-wrap:anywhere}
.ccm-detail-desc{margin:0;font-size:13px;color:var(--ccm-fg2)}
.ccm-trustline{display:flex;align-items:flex-start;gap:9px;margin-top:14px;padding:10px 12px;border-radius:9px;font-size:12.5px;line-height:1.55;
  color:var(--ccm-fg2);background:var(--ccm-hover)}
.ccm-trustline>svg{flex:none;margin-top:2px}
.ccm-trustline[data-trust=verified]{background:color-mix(in srgb,var(--ccm-ok) 9%,transparent)}
.ccm-trustline[data-trust=verified]>svg{color:var(--ccm-ok-fg)}
.ccm-trustline[data-trust=changed]{background:color-mix(in srgb,var(--ccm-warn) 10%,transparent)}
.ccm-trustline[data-trust=changed]>svg{color:var(--ccm-warn-fg)}
.ccm-trustline-text{display:flex;flex-direction:column;gap:2px}
.ccm-facts{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:6px 14px;margin-top:14px;padding:12px 14px;border-radius:9px;
  border:1px solid var(--ccm-line);font-size:12.5px}
.ccm-facts dt{font-weight:600;color:var(--ccm-fg3);white-space:nowrap}
.ccm-facts dd{margin:0;color:var(--ccm-fg);overflow-wrap:anywhere}
.ccm-callout{margin-top:12px;padding:10px 12px;border-radius:9px;font-size:12.5px;
  background:color-mix(in srgb,var(--ccm-danger) 7%,transparent);border:1px solid color-mix(in srgb,var(--ccm-danger) 20%,transparent)}
.ccm-callout-title{display:flex;align-items:center;gap:6px;margin-bottom:4px;font-weight:650;color:var(--ccm-danger)}
.ccm-sub{margin-top:18px}
.ccm-sub-title{margin:0 0 6px;font-size:12px;font-weight:650;color:var(--ccm-fg3)}
.ccm-old{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}
.ccm-old li{padding:6px 10px;border-radius:7px;font-size:12.5px;color:var(--ccm-fg2);background:var(--ccm-hover)}
.ccm-old li s{text-decoration-color:color-mix(in srgb,var(--ccm-fg3) 70%,transparent)}
.ccm-meta{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:20px;padding-top:12px;border-top:1px solid var(--ccm-line);font-size:11.5px;color:var(--ccm-fg3)}
.ccm-inline-error{margin-top:14px;padding:9px 12px;border-radius:8px;font-size:12.5px;color:var(--ccm-danger);
  background:color-mix(in srgb,var(--ccm-danger) 8%,transparent)}
.ccm-only-narrow{display:none}

.ccm-md{margin-top:16px;font-size:13.5px;line-height:1.7;overflow-wrap:anywhere}
.ccm-md>:first-child{margin-top:0}
.ccm-md p{margin:0 0 10px}
.ccm-md ul,.ccm-md ol{margin:0 0 10px;padding-left:20px}
.ccm-md li{margin:2px 0}
.ccm-md .ccm-md-h{margin:16px 0 8px;font-size:14px;font-weight:650}
.ccm-md blockquote{margin:0 0 10px;padding:2px 12px;border-left:3px solid var(--ccm-line2);color:var(--ccm-fg2)}
.ccm-md code{font-family:${MONO};font-size:12px;padding:1px 5px;border-radius:5px;background:var(--ccm-hover)}
.ccm-md pre.ccm-code{margin:0 0 10px;padding:10px 12px;border-radius:8px;background:var(--ccm-hover);overflow:auto}
.ccm-md pre.ccm-code code{padding:0;background:transparent}
.ccm-md a{color:var(--ccm-link)}
.ccm-md hr{border:0;border-top:1px solid var(--ccm-line);margin:14px 0}
.ccm-cite{display:inline-flex;align-items:center;height:17px;margin:0 1px 0 3px;padding:0 5px;border-radius:5px;vertical-align:2px;
  font-family:${MONO};font-size:10.5px;line-height:17px;color:var(--ccm-fg3);background:var(--ccm-hover);cursor:help;white-space:nowrap;
  max-width:220px;overflow:hidden;text-overflow:ellipsis}
.ccm-wlink{display:inline;padding:0 2px;border:0;border-radius:4px;background:color-mix(in srgb,var(--ccm-accent) 9%,transparent);
  color:var(--ccm-link);font:inherit;cursor:pointer}
.ccm-wlink:hover{background:color-mix(in srgb,var(--ccm-accent) 16%,transparent)}
.ccm-wlink.is-dead{color:var(--ccm-danger);background:color-mix(in srgb,var(--ccm-danger) 8%,transparent);cursor:not-allowed}

.ccm-form{display:flex;flex-direction:column;gap:16px;padding:18px 20px 20px}
.ccm-field{display:flex;flex-direction:column;gap:6px}
.ccm-label{font-size:12px;font-weight:600;color:var(--ccm-fg2)}
.ccm-help{font-size:11.5px;color:var(--ccm-fg3)}
.ccm-form-actions{display:flex;align-items:center;gap:8px;justify-content:flex-end}
.ccm-hint-box{padding:9px 12px;border-radius:8px;font-size:12px;color:var(--ccm-warn-fg);
  background:color-mix(in srgb,var(--ccm-warn) 10%,transparent)}

.ccm-empty{display:flex;flex-direction:column;align-items:center;text-align:center;gap:8px;padding:44px 24px}
.ccm-empty-icon{display:flex;align-items:center;justify-content:center;width:46px;height:46px;margin-bottom:4px;border-radius:14px;
  background:color-mix(in srgb,var(--ccm-accent) 10%,transparent);color:var(--ccm-accent)}
.ccm-empty-icon.is-ok{background:color-mix(in srgb,var(--ccm-ok) 12%,transparent);color:var(--ccm-ok-fg)}
.ccm-empty-title{font-size:15px;font-weight:650}
.ccm-empty-text{max-width:440px;font-size:12.5px;line-height:1.65;color:var(--ccm-fg2)}
.ccm-empty .ccm-btn{margin-top:8px}

.ccm-reasons{margin:10px 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:4px}
.ccm-reasons li{display:flex;gap:8px;font-size:12.5px;color:var(--ccm-fg2)}
.ccm-reasons li>svg{flex:none;margin-top:3px;color:var(--ccm-warn)}

.ccm-steps{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:0 2px}
.ccm-step{display:inline-flex;align-items:center;gap:7px;font-size:12px;font-weight:550;color:var(--ccm-fg3)}
.ccm-step-n{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:99px;font-size:11px;font-weight:700;
  border:1.5px solid var(--ccm-line2);color:var(--ccm-fg3);font-variant-numeric:tabular-nums}
.ccm-step[data-state=current]{color:var(--ccm-fg)}
.ccm-step[data-state=current] .ccm-step-n{border-color:var(--ccm-accent);background:var(--ccm-accent);color:#fff}
.ccm-step[data-state=done] .ccm-step-n{border-color:var(--ccm-ok);color:var(--ccm-ok-fg)}
.ccm-step-line{width:22px;height:1.5px;border-radius:2px;background:var(--ccm-line2)}

.ccm-hero{display:flex;flex-direction:column;align-items:flex-start;gap:8px;padding:22px}
.ccm-hero .ccm-empty-icon{margin-bottom:6px}
.ccm-hero-title{font-size:16px;font-weight:650}
.ccm-hero-text{margin:0 0 6px;max-width:640px;font-size:13px;line-height:1.65;color:var(--ccm-fg2)}
.ccm-hero .ccm-field{width:100%;max-width:520px}
.ccm-progress{position:relative;width:100%;height:3px;border-radius:99px;background:var(--ccm-hover);overflow:hidden}
.ccm-progress::after{content:'';position:absolute;top:0;bottom:0;left:0;width:35%;border-radius:inherit;background:var(--ccm-accent);
  animation:ccm-slide 1.3s ease-in-out infinite}
.ccm-big{font-size:26px;font-weight:650;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.ccm-plan-summary{margin:-2px 16px 12px;font-size:13px;line-height:1.6;color:var(--ccm-fg2)}
.ccm-coverage{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:0 16px 12px}
.ccm-op{border-top:1px solid var(--ccm-line)}
.ccm-op-row{display:flex;align-items:center;gap:10px;padding:9px 12px 9px 16px}
.ccm-op.is-muted .ccm-op-row{opacity:.55}
.ccm-op-note{margin:0;padding:0 16px 9px 16px}
.ccm-op.is-refused .ccm-op-file{color:var(--ccm-fg3);text-decoration:line-through}
.ccm-op .ccm-seg{flex:none}
.ccm-op .ccm-seg button[aria-pressed=true]:first-child{color:var(--ccm-ok-fg)}
.ccm-op .ccm-seg button[aria-pressed=true]:last-child{color:var(--ccm-danger)}
.ccm-check{display:flex;align-items:center;justify-content:center;flex:none;width:18px;height:18px;padding:0;border-radius:5px;
  border:1.5px solid var(--ccm-line2);background:var(--ccm-input);color:#fff;cursor:pointer;transition:background .12s,border-color .12s}
.ccm-check[aria-checked=true]{background:var(--ccm-accent);border-color:var(--ccm-accent)}
.ccm-check:disabled{cursor:not-allowed;opacity:.5}
.ccm-opkind{flex:none;min-width:40px;height:20px;padding:0 7px;border-radius:5px;font-size:11px;font-weight:650;line-height:20px;text-align:center;
  color:var(--ccm-k);background:color-mix(in srgb,var(--ccm-k) 13%,transparent)}
.ccm-opkind[data-kind=create]{--ccm-k:var(--ccm-ok-fg)}
.ccm-opkind[data-kind=update]{--ccm-k:var(--ccm-accent)}
.ccm-opkind[data-kind=delete]{--ccm-k:var(--ccm-danger)}
.ccm-opkind[data-kind=index]{--ccm-k:var(--ccm-fg3)}
.ccm-op-toggle{display:flex;align-items:center;gap:10px;flex:1;min-width:0;height:28px;padding:0 6px;border:0;border-radius:6px;
  background:transparent;text-align:left;cursor:pointer}
.ccm-op-toggle:hover{background:var(--ccm-hover)}
.ccm-op-file{flex:1;min-width:0;font-family:${MONO};font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ccm-op-delta{flex:none;font-size:11.5px;color:var(--ccm-fg3);white-space:nowrap;font-variant-numeric:tabular-nums}
.ccm-chev{display:flex;flex:none;color:var(--ccm-fg3);transition:transform .15s}
.ccm-chev.is-open{transform:rotate(90deg)}
.ccm-diff{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:2px 16px 14px 44px}
.ccm-diff-wide{grid-column:1 / -1}
.ccm-diff-label{margin-bottom:4px;font-size:11px;font-weight:650;color:var(--ccm-fg3)}
.ccm-pre{margin:0;padding:10px 12px;border-radius:8px;background:var(--ccm-hover);font-family:${MONO};font-size:12px;line-height:1.6;
  white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px;overflow:auto;color:var(--ccm-fg2)}
.ccm-pre-after{background:color-mix(in srgb,var(--ccm-ok) 9%,transparent);color:var(--ccm-fg)}
.ccm-pre-removed{background:color-mix(in srgb,var(--ccm-danger) 7%,transparent)}
.ccm-quotes{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
.ccm-quotes li{padding:6px 10px;border-left:3px solid color-mix(in srgb,var(--ccm-accent) 45%,transparent);border-radius:0 7px 7px 0;
  background:var(--ccm-hover);font-size:12px;color:var(--ccm-fg2)}
.ccm-quotes q{display:block;color:var(--ccm-fg);quotes:none}
.ccm-notes{display:flex;flex-direction:column;gap:4px;padding:10px 16px 0;border-top:1px solid var(--ccm-line)}
.ccm-note{font-size:12px;color:var(--ccm-fg3)}
.ccm-note-error{color:var(--ccm-danger)}
.ccm-note-warn{color:var(--ccm-warn-fg)}
.ccm-foot{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 16px;border-top:1px solid var(--ccm-line)}

.ccm-setting{display:flex;align-items:center;gap:16px;padding:14px 16px;border-top:1px solid var(--ccm-line)}
.ccm-setting:first-child{border-top:0}
.ccm-setting-text{flex:1;min-width:0}
.ccm-setting-name{font-size:13.5px;font-weight:550}
.ccm-setting-hint{margin-top:2px;font-size:12px;color:var(--ccm-fg3)}
.ccm-switch{position:relative;flex:none;width:38px;height:22px;padding:0;border:0;border-radius:99px;background:var(--ccm-line2);cursor:pointer;
  transition:background .18s}
.ccm-switch::after{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:99px;background:#fff;
  box-shadow:0 1px 2px rgba(0,0,0,.3);transition:transform .18s}
.ccm-switch[aria-checked=true]{background:var(--ccm-ok)}
.ccm-switch[aria-checked=true]::after{transform:translateX(16px)}
.ccm-switch:disabled{opacity:.45;cursor:not-allowed}
.ccm-kv{display:grid;grid-template-columns:minmax(120px,max-content) minmax(0,1fr);gap:10px 18px;padding:2px 16px 16px;font-size:12.5px}
.ccm-kv dt{color:var(--ccm-fg3);font-weight:600}
.ccm-kv dd{margin:0;color:var(--ccm-fg);min-width:0}
.ccm-meter{height:6px;margin-top:6px;border-radius:99px;background:var(--ccm-hover);overflow:hidden}
.ccm-meter>span{display:block;height:100%;border-radius:inherit;background:var(--ccm-accent);transition:width .3s}
.ccm-meter.is-warn>span{background:var(--ccm-warn)}
.ccm-meter.is-over>span{background:var(--ccm-danger)}
.ccm-hist{display:flex;align-items:center;gap:12px;padding:11px 16px;border-top:1px solid var(--ccm-line)}
.ccm-tasks-bar{display:flex;gap:2px;height:10px;margin:0 16px;border-radius:99px;overflow:hidden;background:var(--ccm-line)}
.ccm-task-seg{flex-basis:0;min-width:4px}
.ccm-tasks-legend{display:flex;flex-wrap:wrap;gap:6px 14px;padding:10px 16px 4px;font-size:12px;color:var(--ccm-fg2)}
.ccm-task-key{display:inline-flex;align-items:center;gap:6px}
.ccm-task-key b{color:var(--ccm-fg);font-weight:620;font-variant-numeric:tabular-nums}
.ccm-task-dot{width:8px;height:8px;border-radius:99px}
.ccm-tasks-filter{display:flex;gap:6px;padding:8px 16px 10px}
.ccm-tasks-filter .ccm-on{background:var(--ccm-active);color:var(--ccm-fg)}
.ccm-task-name{color:var(--ccm-fg);-webkit-line-clamp:1}
.ccm-task-done{background:var(--ccm-ok)}
.ccm-task-review{background:var(--ccm-accent)}
.ccm-task-new{background:var(--ccm-warn)}
.ccm-task-partial{background:color-mix(in srgb,var(--ccm-warn) 55%,transparent)}
.ccm-task-todo{background:var(--ccm-line2)}
.ccm-task-excluded{background:var(--ccm-line)}
.ccm-task-pill{color:var(--ccm-fg);white-space:nowrap}
.ccm-task-pill.ccm-task-done{background:color-mix(in srgb,var(--ccm-ok) 18%,transparent);color:var(--ccm-ok-fg)}
.ccm-task-pill.ccm-task-review{background:color-mix(in srgb,var(--ccm-accent) 16%,transparent);color:var(--ccm-link)}
.ccm-task-pill.ccm-task-new,.ccm-task-pill.ccm-task-partial{background:color-mix(in srgb,var(--ccm-warn) 18%,transparent);color:var(--ccm-warn-fg)}
.ccm-task-pill.ccm-task-todo,.ccm-task-pill.ccm-task-excluded{background:var(--ccm-hover);color:var(--ccm-fg2)}
.ccm-fold{display:flex;align-items:center;gap:10px;width:100%;padding:12px 16px;border:0;border-top:1px solid var(--ccm-line);
  background:transparent;text-align:left;cursor:pointer;font-size:13px;font-weight:550}
.ccm-fold:hover{background:var(--ccm-hover)}
.ccm-fold-inline{padding:6px 0;border-top:0;font-size:12px;font-weight:650;color:var(--ccm-fg3);background:transparent!important}
.ccm-fold-inline:hover{color:var(--ccm-fg)}
.ccm-batch{padding:0 16px 4px 40px}
.ccm-batch-head{display:flex;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--ccm-line)}
.ccm-batch-file{display:flex;align-items:center;gap:8px;padding:4px 0 4px 18px;font-size:12px}
.ccm-batch-file .ccm-mono{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ccm-fg2)}
.ccm-timeline{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:2px}
.ccm-timeline li{display:flex;gap:10px;padding:5px 0;font-size:12px;color:var(--ccm-fg2)}
.ccm-timeline time{flex:none;min-width:112px;color:var(--ccm-fg3);font-variant-numeric:tabular-nums}
.ccm-path{display:flex;align-items:center;gap:6px;margin-top:6px}
.ccm-path code{flex:1;min-width:0;padding:7px 10px;border-radius:8px;background:var(--ccm-hover);font-family:${MONO};font-size:12px;
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}

.ccm-domain{padding:10px 16px 4px;font-size:11px;font-weight:700;color:var(--ccm-fg3);letter-spacing:.02em;text-transform:uppercase;
  border-top:1px solid var(--ccm-line)}
.ccm-domain:first-child{border-top:0}
.ccm-domain+.ccm-row{border-top:0}

.ccm-skel-row{display:flex;align-items:flex-start;gap:12px;padding:14px 16px;border-top:1px solid var(--ccm-line)}
.ccm-skel-row:first-child{border-top:0}
.ccm-skel-lines{flex:1;display:flex;flex-direction:column;gap:8px}
.ccm-skel{display:block;height:10px;border-radius:6px;background:var(--ccm-hover);animation:ccm-pulse 1.4s ease-in-out infinite}
.ccm-skel-dot{width:8px;height:8px;border-radius:99px;margin-top:2px}

.ccm-toast-dock{position:absolute;left:0;right:0;bottom:20px;display:flex;justify-content:center;padding:0 16px;pointer-events:none;z-index:5}
.ccm-toast{display:flex;align-items:flex-start;gap:8px;max-width:620px;padding:9px 8px 9px 14px;border-radius:10px;pointer-events:auto;
  background:var(--ccm-strong);color:var(--ccm-on-strong);font-size:12.5px;line-height:1.5;box-shadow:0 10px 30px rgba(0,0,0,.2);
  animation:ccm-pop .18s ease-out}
.ccm-toast>svg{flex:none;margin-top:2px}
.ccm-toast-error{background:var(--ccm-danger);color:#fff}
.ccm-toast-body{flex:1;min-width:0;max-height:40vh;overflow:auto;overflow-wrap:anywhere}
.ccm-toast.has-items .ccm-toast-title{font-weight:650}
.ccm-toast-items{margin:6px 0 2px;padding-left:16px;display:flex;flex-direction:column;gap:4px}
.ccm-toast-close{flex:none;display:flex;align-items:center;justify-content:center;width:22px;height:22px;padding:0;border:0;border-radius:6px;
  background:transparent;color:inherit;opacity:.75;cursor:pointer}
.ccm-toast-close:hover{opacity:1;background:rgba(255,255,255,.16)}

@keyframes ccm-spin{to{transform:rotate(360deg)}}
@keyframes ccm-slide{0%{transform:translateX(-100%)}100%{transform:translateX(290%)}}
@keyframes ccm-pulse{0%,100%{opacity:1}50%{opacity:.45}}
@keyframes ccm-pop{from{transform:translateY(8px)}to{transform:none}}
@media (prefers-reduced-motion:reduce){.ccm-root *{animation:none!important;transition:none!important}}

@container (max-width:760px){
  .ccm-shell{padding:0 16px}
  .ccm-scroll>.ccm-shell{padding:14px 16px 20px}
  .ccm-head{padding-top:14px}
  .ccm-split.has-detail{grid-template-columns:minmax(0,1fr)}
  .ccm-split.has-detail .ccm-listpane{display:none}
  .ccm-detail{position:static;max-height:none}
  .ccm-detail-body,.ccm-detail .ccm-form{overflow:visible}
  .ccm-only-narrow{display:inline-flex}
  .ccm-only-wide{display:none}
  .ccm-diff{padding-left:16px;grid-template-columns:minmax(0,1fr)}
  .ccm-kv{grid-template-columns:minmax(0,1fr);gap:2px 0}
  .ccm-kv dd{margin-bottom:8px}
}
`;

/** The composer chip renders outside the page, so it carries its own CSS. */
export const CHIP_CSS = `
.ccm-chip-dock{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 9px;border-radius:99px;font-size:12px;white-space:nowrap;
  color:var(--dsw-alias-label-secondary,#575c63);background:var(--dsw-alias-interactive-bg-hover,rgba(38,49,72,.06))}
.ccm-chip-dot{width:6px;height:6px;border-radius:99px;background:var(--dsw-alias-label-tertiary,#9aa0a6)}
.ccm-chip-dot[data-on=true]{background:var(--dsw-alias-state-success-primary,#22c55e)}
.ccm-chip-count{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary,#8a8f96)}
.ccm-chip-alert{font-weight:600;color:var(--dsw-alias-state-warn-label,#b45309)}
`;
