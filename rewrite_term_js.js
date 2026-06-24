const fs = require('fs');
let html = fs.readFileSync('index.html', 'utf8');

// 1. Add JS functions
const newJsFunctions = `
        window.activeDetailsTab = 'payload';
        window.activeMobileTab = 'logs';
        window.activeSelectedMeta = null;

        window.setDetailsTab = function(tab) {
            window.activeDetailsTab = tab;
            document.getElementById('dtab-payload').className = tab === 'payload' ? 'tab on' : 'tab';
            document.getElementById('dtab-response').className = tab === 'response' ? 'tab on' : 'tab';
            
            // Sync mobile tabs if we are on details
            if (window.activeMobileTab !== 'logs') {
                window.activeMobileTab = tab;
                document.getElementById('mtab-payload').className = tab === 'payload' ? 'tab on' : 'tab';
                document.getElementById('mtab-response').className = tab === 'response' ? 'tab on' : 'tab';
            }
            
            window.renderDetailsContent();
        };

        window.setMobileTermTab = function(tab) {
            window.activeMobileTab = tab;
            document.getElementById('mtab-logs').className = tab === 'logs' ? 'tab on' : 'tab';
            document.getElementById('mtab-payload').className = tab === 'payload' ? 'tab on' : 'tab';
            document.getElementById('mtab-response').className = tab === 'response' ? 'tab on' : 'tab';
            
            const wrap = document.getElementById('term-body-wrap');
            if (tab === 'logs') {
                wrap.className = 'term-scanline show-logs';
            } else {
                wrap.className = 'term-scanline show-details';
                window.setDetailsTab(tab); // Sync desktop tabs visually too
            }
        };

        window.renderDetailsContent = function() {
            const pane = document.getElementById('term-details-content');
            if (!window.activeSelectedMeta) {
                pane.innerHTML = '<div style="text-align:center; padding:40px 0; color:var(--text-muted); font-style:italic;">Select a log to view details</div>';
                return;
            }
            
            let displayData = '';
            // Determine if meta has req/res structure
            if (window.activeSelectedMeta.req || window.activeSelectedMeta.res || window.activeSelectedMeta.request || window.activeSelectedMeta.response) {
                if (window.activeDetailsTab === 'payload') {
                    displayData = window.activeSelectedMeta.req || window.activeSelectedMeta.request || window.activeSelectedMeta;
                } else {
                    displayData = window.activeSelectedMeta.res || window.activeSelectedMeta.response || window.activeSelectedMeta.error || 'No response data';
                }
            } else {
                displayData = window.activeSelectedMeta;
            }
            
            let metaStr = typeof displayData === 'string' ? displayData : JSON.stringify(displayData, null, 2);
            metaStr = metaStr.replace(/</g, '&lt;').replace(/>/g, '&gt;');
            pane.innerHTML = metaStr;
        };

        window.openTermDetails = function(metaStrEncoded, rowEl) {
            try {
                window.activeSelectedMeta = JSON.parse(decodeURIComponent(metaStrEncoded));
            } catch(e) {
                window.activeSelectedMeta = { raw: decodeURIComponent(metaStrEncoded) };
            }
            
            // Highlight selected row
            const rows = document.querySelectorAll('.term-log-row');
            rows.forEach(r => r.style.backgroundColor = 'transparent');
            if (rowEl) rowEl.style.backgroundColor = 'var(--row-hover)';
            
            // Switch to payload tab
            window.setDetailsTab('payload');
            
            // If on mobile, switch to mobile details view
            if (window.innerWidth <= 900) {
                window.setMobileTermTab('payload');
            }
        };
`;

// Insert the functions right before `window.renderTerminalLogs = function(logs) {`
html = html.replace('window.renderTerminalLogs = function(logs) {', newJsFunctions + '\n        window.renderTerminalLogs = function(logs) {');

// 2. Rewrite renderTerminalLogs loop body to use clickable rows instead of DETAILS button
const newRenderLogs = `
                let cursor = l.meta ? 'pointer' : 'default';
                let onClick = '';
                let hoverClass = l.meta ? 'class="term-log-row" onmouseover="this.style.backgroundColor=\\'var(--row-hover)\\'" onmouseout="if(this.dataset.selected!==\\'true\\')this.style.backgroundColor=\\'transparent\\'"' : 'class="term-log-row"';
                
                let metaHtml = '';
                if (l.meta) {
                    const encodedMeta = encodeURIComponent(JSON.stringify(l.meta));
                    onClick = \`onclick="document.querySelectorAll('.term-log-row').forEach(r=>{r.dataset.selected='false';r.style.backgroundColor='transparent'}); this.dataset.selected='true'; window.openTermDetails('\${encodedMeta}', this)"\`;
                    metaHtml = '<span style="color:var(--cyan);font-size:9px;margin-left:8px;padding:2px 4px;background:rgba(6,182,212,0.1);border-radius:4px;font-weight:700;">DETAILS</span>';
                }
                
                html += \`<div \${hoverClass} \${onClick} style="padding:4px 8px; margin-bottom:2px; word-break:break-all; cursor:\${cursor}; border-radius:4px; transition:background-color 0.2s;"><span style="color:#64748b;">[\${l.time}]</span> <span style="color:\${tagColor};font-weight:700;">[\${l.level}]</span> <span style="color:#a855f7;font-weight:600;">[\${l.sym}]</span> <span style="color:\${color};">\${l.msg}</span>\${metaHtml}</div>\`;
            }
`;

html = html.replace(/let metaHtml = '';\s*if \(l\.meta\) \{[\s\S]*?\}\s*html \+= `<div style="margin-bottom:4px;word-break:break-all;"[\s\S]*?<\/div>`;\s*\}/, newRenderLogs);

fs.writeFileSync('index.html', html);
console.log('Terminal JS logic updated.');
