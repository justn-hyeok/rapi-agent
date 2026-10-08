import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const BRIEFING_LINK_DAYS = 14;

/** Domain-separated key so the link signature never reuses another secret's role. */
export function briefingLinkKey(secret: string): Buffer {
  return createHmac("sha256", secret).update("rapi-briefing-link-v1").digest();
}

function signature(key: Buffer, batchId: string, expires: number): string {
  return createHmac("sha256", key)
    .update(`${batchId}.${expires}`)
    .digest("base64url");
}

export function signBriefingToken(
  key: Buffer,
  batchId: string,
  now = new Date(),
): string {
  const expires = Math.floor(now.getTime() / 1000) + BRIEFING_LINK_DAYS * 86400;
  return `${expires}.${signature(key, batchId, expires)}`;
}

export function verifyBriefingToken(
  key: Buffer,
  batchId: string,
  token: string,
  now = new Date(),
): boolean {
  const match = /^(\d{10})\.([\w-]{43})$/.exec(token);
  if (!match) return false;
  const expires = Number(match[1]);
  if (expires * 1000 < now.getTime()) return false;
  const expected = Buffer.from(signature(key, batchId, expires));
  const given = Buffer.from(match[2]!);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export const BRIEFING_SECTIONS = [
  { id: "tools", label: "도구 변화" },
  { id: "industry", label: "논문·업계" },
  { id: "github", label: "GitHub" },
  { id: "korea", label: "국내" },
] as const;

export type BriefingSection = (typeof BRIEFING_SECTIONS)[number]["id"];

export interface BriefingPageEntry {
  id: string;
  title: string;
  url: string;
  summary: string;
  source: string;
  section: BriefingSection;
  meta: string;
  why?: string;
  repository: boolean;
  feedback: { up: boolean; down: boolean; save: boolean };
}

export interface BriefingPageEvent {
  id: string;
  title: string;
  url: string | null;
  kind: string;
  source: string;
  when: string;
  daysUntil: number;
}

export interface BriefingPageView {
  batchId: string;
  token: string;
  dateLabel: string;
  entries: BriefingPageEntry[];
  events?: BriefingPageEvent[];
}

function escape(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
}

const ICONS = {
  up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 11v9H4v-9zM7 11l4-8c1.7 0 2.5 1 2.2 2.6L12.6 9H19a2 2 0 0 1 2 2.3l-1.3 7A2 2 0 0 1 17.7 20H7"/></svg>',
  down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 13V4h3v9zM17 13l-4 8c-1.7 0-2.5-1-2.2-2.6l.6-3.4H5a2 2 0 0 1-2-2.3l1.3-7A2 2 0 0 1 6.3 4H17"/></svg>',
  save: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>',
  open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
};

// Tokens extend the public blog palette (scripts/build-blog.mjs); see the
// approved "Rapi briefing" preset. Only surface, accent-soft and urgent are new.
const STYLE = `
:root{color-scheme:light;--bg:#faf9f5;--fg:#252722;--muted:#65685e;--accent:#365d46;--line:#d9dcd1;--surface:#f2f1ea;--accent-soft:#e3ebe3;--urgent:#9a3b2e;--font-body:system-ui,-apple-system,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;--font-mono:ui-monospace,"SF Mono",Menlo,monospace}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#171b18;--fg:#edf1e8;--muted:#a5afa0;--accent:#a6d1ad;--line:#343e34;--surface:#1f2520;--accent-soft:#24342a;--urgent:#e79a8c}}
*{box-sizing:border-box}
[hidden]{display:none!important}
.nb{white-space:nowrap}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 var(--font-body);word-break:keep-all;overflow-wrap:anywhere;padding-inline:16px;padding-block:env(safe-area-inset-top,0px) 48px}
.wrap{max-width:680px;margin:0 auto}
a{color:var(--accent);text-underline-offset:3px}
a:focus-visible,button:focus-visible{outline:2px solid var(--accent);outline-offset:3px;border-radius:4px}
.top{padding-block:28px 4px;display:grid;gap:2px}
.top .date{color:var(--muted);font-size:.85rem;font-variant-numeric:tabular-nums}
.top h1{margin:0;font-size:1.55rem;letter-spacing:-.035em;line-height:1.3;text-wrap:balance}
.tabs{position:sticky;top:env(safe-area-inset-top,0px);z-index:2;background:var(--bg);display:flex;gap:20px;border-bottom:1px solid var(--line);margin-top:14px}
.tabs button{appearance:none;background:none;border:0;padding:12px 0 10px;font:inherit;font-size:.95rem;color:var(--muted);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px}
.tabs button[aria-selected="true"]{color:var(--fg);font-weight:600;border-color:var(--fg)}
.tabs .n{font-variant-numeric:tabular-nums;color:var(--muted);font-weight:400;margin-left:4px}
.filters{display:flex;gap:8px;flex-wrap:wrap;padding-block:14px 4px}
.chip{appearance:none;font:inherit;font-size:.82rem;border:1px solid var(--line);background:none;color:var(--muted);padding:3px 10px;border-radius:999px;cursor:pointer;min-height:32px}
.chip[aria-pressed="true"]{background:var(--fg);border-color:var(--fg);color:var(--bg)}
section h2{font-size:.8rem;letter-spacing:.06em;color:var(--muted);font-weight:600;margin:26px 0 0;display:flex;justify-content:space-between}
.item{padding-block:16px;border-bottom:1px solid var(--line);display:grid;gap:6px}
.item:last-child{border-bottom:0}
.meta{display:flex;gap:8px;align-items:baseline;font-size:.8rem;color:var(--muted);flex-wrap:wrap}
.src{color:var(--fg);font-weight:600}
.item h3{margin:0;font-size:1.02rem;line-height:1.45;letter-spacing:-.01em}
.item h3 a{color:var(--fg);text-decoration:none}
.item h3 a:hover{text-decoration:underline}
.repo{font-family:var(--font-mono);font-size:.92rem}
.item p{margin:0}
.why{font-size:.82rem;color:var(--muted)}
.actions{display:flex;gap:4px;margin-top:2px;margin-left:-8px;flex-wrap:wrap}
.act{appearance:none;background:none;border:0;font:inherit;font-size:.82rem;color:var(--muted);padding:6px 8px;min-height:36px;border-radius:6px;display:inline-flex;gap:5px;align-items:center;cursor:pointer;text-decoration:none}
.act:hover{background:var(--surface);color:var(--fg)}
.act svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:1.8}
.act[aria-pressed="true"]{color:var(--accent);background:var(--accent-soft)}
.act[aria-pressed="true"] svg{fill:currentColor}
.act.more{margin-left:auto;color:var(--accent)}
.empty,.note{font-size:.85rem;color:var(--muted);margin:20px 0 0}
.add{display:grid;grid-template-columns:1fr auto;gap:8px;margin-top:16px}
.add input{font:inherit;padding:9px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--fg);min-width:0}
.btn{appearance:none;font:inherit;padding:9px 14px;min-height:40px;border-radius:8px;border:0;background:var(--fg);color:var(--bg);cursor:pointer}
.btn.ghost{background:none;color:var(--muted);border:1px solid var(--line)}
.hint{font-size:.8rem;color:var(--muted);margin:6px 0 0}
.preview{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:10px;padding:10px 12px;border:1px solid var(--line);border-radius:8px}
.preview b{flex:1 1 200px;min-width:0}
.ev{display:grid;grid-template-columns:1fr auto;gap:4px 12px;padding-block:14px;border-bottom:1px solid var(--line)}
.ev .when{font-variant-numeric:tabular-nums;font-size:.85rem;color:var(--muted)}
.ev h3{margin:0;font-size:.98rem;font-weight:600;grid-column:1}
.ev h3 a{color:var(--fg);text-decoration:none}
.ev .k{font-size:.8rem;color:var(--muted);grid-column:1}
.ev .act{grid-column:2;grid-row:1 / span 3;align-self:center}
.dday{display:inline-block;font-size:.72rem;font-weight:600;padding:1px 7px;border-radius:999px;border:1px solid currentColor;color:var(--muted);margin-left:6px;vertical-align:1px}
.dday.soon{color:var(--urgent)}
.note[role="alert"]{color:var(--urgent)}
@media (prefers-reduced-motion:no-preference){.act{transition:background .12s,color .12s}}
`;

const SCRIPT = `
const SOURCE={manual:"직접 추가","dev-event":"국내 행사",devpost:"해커톤",cfp:"CFP"};
function esc(v){return String(v).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]);}
let events=JSON.parse(document.getElementById("events-data").textContent);
function renderEvents(){
  const list=document.getElementById("events");
  document.getElementById("sched-n").textContent=events.length;
  if(!events.length){list.innerHTML='<p class="empty">앞으로 30일 안의 일정과 마감이 없습니다. 위 입력창에 문장으로 추가해 보세요.</p>';return;}
  list.innerHTML=events.map(e=>{
    const d=e.daysUntil<0?"지남":e.daysUntil===0?"오늘":"D-"+e.daysUntil;
    const title=e.url?'<a href="'+esc(e.url)+'" target="_blank" rel="noopener noreferrer">'+esc(e.title)+'</a>':esc(e.title);
    return '<div class="ev" data-id="'+esc(e.id)+'"><span class="when">'+esc(e.when)+'<span class="dday'+(e.daysUntil>=0&&e.daysUntil<=7?' soon':'')+'">'+d+'</span></span><h3>'+title+'</h3><span class="k">'+esc(SOURCE[e.source]||e.source)+'</span><button class="act" data-del="'+esc(e.id)+'">'+(e.source==="manual"?"지우기":"숨기기")+'</button></div>';
  }).join("");
}
async function schedule(payload){
  const r=await fetch("/b/"+batch+"/events",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({t:token,...payload})});
  const body=await r.json().catch(()=>({ok:false,message:"응답을 읽지 못했습니다."}));
  if(body.events){events=body.events;renderEvents();}
  return body;
}

const root=document.getElementById("app");const batch=root.dataset.batch,token=root.dataset.token;
const note=document.getElementById("note");
async function send(item,kind,on){
  const r=await fetch("/b/"+batch+"/feedback",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({t:token,itemId:item,kind,on}),keepalive:true});
  if(!r.ok)throw new Error(String(r.status));
}
function savedCount(){document.getElementById("saved-n").textContent=document.querySelectorAll('.act[data-k="save"][aria-pressed="true"]').length;}
function applyView(){
  const tab=document.querySelector('[role="tab"][aria-selected="true"]').id;
  document.getElementById("p-sched").hidden=tab!=="t-sched";
  document.getElementById("p-brief").hidden=tab==="t-sched";
  if(tab==="t-sched")return;
  const chip=document.querySelector('.chip[aria-pressed="true"]').dataset.section;
  document.querySelectorAll("section[data-section]").forEach(s=>{
    let shown=0;
    s.querySelectorAll(".item").forEach(it=>{
      const saved=it.querySelector('.act[data-k="save"]').getAttribute("aria-pressed")==="true";
      const ok=(tab==="t-saved"?saved:true)&&(chip==="all"||chip===s.dataset.section);
      it.hidden=!ok;if(ok)shown++;
    });
    s.hidden=shown===0;
  });
  document.getElementById("empty").hidden=!!document.querySelector("section[data-section]:not([hidden])");
}
document.addEventListener("click",async e=>{
  const act=e.target.closest(".act[data-k]");
  if(act){
    const item=act.closest(".item").dataset.item,kind=act.dataset.k,on=act.getAttribute("aria-pressed")!=="true";
    const group=act.closest(".actions");const before=[...group.querySelectorAll(".act[data-k]")].map(b=>b.getAttribute("aria-pressed"));
    if(on&&(kind==="up"||kind==="down"))group.querySelectorAll('.act[data-k="up"],.act[data-k="down"]').forEach(b=>b.setAttribute("aria-pressed","false"));
    act.setAttribute("aria-pressed",String(on));savedCount();
    try{await send(item,kind,on);note.hidden=true;}catch{
      group.querySelectorAll(".act[data-k]").forEach((b,i)=>b.setAttribute("aria-pressed",before[i]));savedCount();
      note.textContent="저장하지 못했습니다. 연결을 확인하고 다시 눌러 주세요.";note.hidden=false;
    }
    applyView();return;
  }
  const open=e.target.closest(".act.more");
  if(open){send(open.closest(".item").dataset.item,"open",true).catch(()=>{});return;}
  const chip=e.target.closest(".chip");
  if(chip){document.querySelectorAll(".chip").forEach(c=>c.setAttribute("aria-pressed",String(c===chip)));applyView();return;}
  const tab=e.target.closest('[role="tab"]');
  if(tab){document.querySelectorAll('[role="tab"]').forEach(t=>t.setAttribute("aria-selected",String(t===tab)));applyView();return;}
  const del=e.target.closest("[data-del]");
  if(del){const b=await schedule({action:"delete",id:del.dataset.del});if(!b.ok){note.textContent=b.message;note.hidden=false;}return;}
  if(e.target.id==="confirm"){const b=await schedule({action:"add",text:document.getElementById("add-input").value});
    document.getElementById("preview").hidden=true;
    if(b.ok){document.getElementById("add-input").value="";document.getElementById("sched-msg").textContent=b.message;}
    else document.getElementById("sched-msg").textContent=b.message;return;}
  if(e.target.id==="cancel"){document.getElementById("preview").hidden=true;return;}
});
document.getElementById("add-form").addEventListener("submit",async e=>{
  e.preventDefault();
  const b=await schedule({action:"preview",text:document.getElementById("add-input").value});
  const msg=document.getElementById("sched-msg");
  if(b.ok){document.getElementById("preview-text").textContent=b.message;document.getElementById("preview").hidden=false;msg.textContent="";}
  else{document.getElementById("preview").hidden=true;msg.textContent=b.message;}
});
renderEvents();
savedCount();applyView();
`;

function actions(entry: BriefingPageEntry): string {
  const button = (kind: "up" | "down" | "save", label: string) =>
    `<button class="act" data-k="${kind}" aria-pressed="${entry.feedback[kind]}">${ICONS[kind]}<span>${label}</span></button>`;
  return `<div class="actions">${button("up", "좋아요")}${button("down", "별로")}${button("save", "저장")}<a class="act more" href="${escape(entry.url)}" target="_blank" rel="noopener noreferrer">${ICONS.open}<span>자세히</span></a></div>`;
}

export function renderBriefingPage(
  view: BriefingPageView,
  nonce = randomBytes(16).toString("base64"),
): { html: string; nonce: string } {
  const sections = BRIEFING_SECTIONS.map((section) => {
    const entries = view.entries.filter(
      (entry) => entry.section === section.id,
    );
    if (!entries.length) return "";
    const items = entries
      .map(
        (entry) => `<article class="item" data-item="${escape(entry.id)}">
<div class="meta"><span class="src">${escape(entry.source)}</span>${entry.meta ? `<span>${escape(entry.meta)}</span>` : ""}</div>
<h3><a${entry.repository ? ' class="repo"' : ""} href="${escape(entry.url)}" target="_blank" rel="noopener noreferrer">${escape(entry.title)}</a></h3>
<p>${escape(entry.summary)}</p>${entry.why ? `\n<span class="why">${escape(entry.why)}</span>` : ""}
${actions(entry)}
</article>`,
      )
      .join("\n");
    return `<section data-section="${section.id}" aria-labelledby="s-${section.id}"><h2 id="s-${section.id}"><span>${section.label}</span><span>${entries.length}</span></h2>${items}</section>`;
  }).join("\n");
  const chips = [
    `<button class="chip" data-section="all" aria-pressed="true">전체</button>`,
    ...BRIEFING_SECTIONS.filter((section) =>
      view.entries.some((entry) => entry.section === section.id),
    ).map(
      (section) =>
        `<button class="chip" data-section="${section.id}" aria-pressed="false">${section.label}</button>`,
    ),
  ].join("");
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>라피 브리핑 · ${escape(view.dateLabel)}</title><style nonce="${nonce}">${STYLE}</style></head><body>
<div class="wrap" id="app" data-batch="${escape(view.batchId)}" data-token="${escape(view.token)}">
<header class="top"><span class="date">${escape(view.dateLabel)}</span><h1>오늘 볼 것 ${view.entries.length}건</h1></header>
<nav class="tabs" role="tablist" aria-label="보기 전환"><button role="tab" id="t-brief" aria-selected="true">브리핑<span class="n">${view.entries.length}</span></button><button role="tab" id="t-sched" aria-selected="false">일정·마감<span class="n" id="sched-n">${(view.events ?? []).length}</span></button><button role="tab" id="t-saved" aria-selected="false">저장<span class="n" id="saved-n">0</span></button></nav>
<main><p class="note" id="note" role="alert" hidden></p>
<div id="p-brief"><div class="filters" aria-label="분류">${chips}</div>
${sections}
<p class="empty" id="empty" hidden>여기에 보일 항목이 없습니다. 저장을 누른 항목은 저장 탭에 모입니다.</p></div>
<div id="p-sched" hidden>
<form class="add" id="add-form"><input id="add-input" autocomplete="off" placeholder="예: 금요일 오후 3시 면담, 10/20 해커톤 마감" aria-label="일정 추가"><button class="btn" type="submit">추가</button></form>
<p class="hint">문장으로 쓰면 날짜와 시간을 나눠서 먼저 보여 드립니다. Discord에서 <span class="nb">/일정</span> 명령으로 추가해도 같은 곳에 저장됩니다.</p>
<div class="preview" id="preview" hidden><b id="preview-text"></b><button class="btn" id="confirm" type="button">저장</button><button class="btn ghost" id="cancel" type="button">취소</button></div>
<p class="hint" id="sched-msg" role="status"></p>
<div id="events"></div>
</div>
</main></div><script type="application/json" id="events-data">${JSON.stringify(view.events ?? []).replace(/</g, "\\u003c")}</script><script nonce="${nonce}">${SCRIPT}</script></body></html>`;
  return { html, nonce };
}
