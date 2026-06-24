const fs = require('fs');
let html = fs.readFileSync('index.html', 'utf8');

// 1. Inject CSS for Responsive Terminal
const responsiveCss = `
  @media (max-width: 900px) {
    #mobile-term-tabs { display: flex !important; }
    #term-desktop-details-tabs { display: none !important; }
    #term-body-wrap { flex-direction: column !important; }
    #term-details-pane { width: 100% !important; border-left: none !important; flex: 1; }
    
    #term-body-wrap.show-logs #live-terminal { display: block !important; flex: 1; }
    #term-body-wrap.show-logs #term-details-pane { display: none !important; }

    #term-body-wrap.show-details #live-terminal { display: none !important; }
    #term-body-wrap.show-details #term-details-pane { display: flex !important; flex: 1; }
  }
</style>`;
html = html.replace('</style>', responsiveCss);

// 2. Rewrite #term-body-wrap to support Split View
const newTermBody = `
    <div id="mobile-term-tabs" style="display:none; border-bottom:1px solid var(--border); background:var(--input-bg); flex-shrink:0;">
       <button id="mtab-logs" class="tab on" style="flex:1" onclick="window.setMobileTermTab('logs')">Logs</button>
       <button id="mtab-payload" class="tab" style="flex:1" onclick="window.setMobileTermTab('payload')">Payload</button>
       <button id="mtab-response" class="tab" style="flex:1" onclick="window.setMobileTermTab('response')">Response</button>
    </div>
    <div id="term-body-wrap" class="term-scanline show-logs" style="flex:1;display:flex;flex-direction:row;min-height:0;">
      <div id="live-terminal" class="term-content" style="flex:1; border-right:1px solid var(--border); overflow-y:auto; padding:12px; font-family:'JetBrains Mono',monospace;">
        <div style="color:#64748b;margin-bottom:12px;font-style:italic;">Initializing replication daemon... Waiting for SSE stream.</div>
      </div>
      <div id="term-details-pane" style="width:400px; display:flex; flex-direction:column; background:var(--panel);">
        <div id="term-desktop-details-tabs" style="display:flex; border-bottom:1px solid var(--border); background:var(--input-bg); flex-shrink:0;">
           <button id="dtab-payload" class="tab on" style="flex:1;font-size:10px;padding:8px 0;" onclick="window.setDetailsTab('payload')">Payload</button>
           <button id="dtab-response" class="tab" style="flex:1;font-size:10px;padding:8px 0;" onclick="window.setDetailsTab('response')">Response</button>
        </div>
        <div id="term-details-content" style="flex:1; overflow-y:auto; padding:12px; font-family:'JetBrains Mono',monospace; font-size:10px; color:var(--text-dim); white-space:pre-wrap; word-break:break-all;">
           <div style="text-align:center; padding:40px 0; color:var(--text-muted); font-style:italic;">Select a log to view details</div>
        </div>
      </div>
    </div>`;

html = html.replace(
    /<div id="term-body-wrap" class="term-scanline" style="flex:1;display:flex;flex-direction:column;min-height:0;">[\s\S]*?<div id="live-terminal" class="term-content">[\s\S]*?<\/div>\s*<\/div>/,
    newTermBody
);

fs.writeFileSync('index.html', html);
console.log('Terminal layout structure updated.');
