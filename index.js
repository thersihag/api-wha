const express = require('express');
const { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Global State Variables
let sock = null;
let qrCodeData = null;
let connectionStatus = 'DISCONNECTED'; // DISCONNECTED, CONNECTING, CONNECTED
let loggedInUser = null;
let systemLogs = [];
let isSending = false;

const sessionDir = path.join(__dirname, 'wa_session');

// Helper function logger me status update add karne ke liye
function addLog(message, type = 'info') {
    const time = new Date().toLocaleTimeString();
    systemLogs.push({ time, message, type });
    if (systemLogs.length > 80) systemLogs.shift(); // Keep logs clean
}

// WhatsApp Connection Engine
async function connectToWhatsApp() {
    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
        const { version } = await fetchLatestBaileysVersion();

        connectionStatus = 'CONNECTING';
        addLog("WhatsApp verification stream processing...", "warn");

        sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            logger: pino({ level: 'silent' })
        });

        sock.ev.on('creds.update', saveCreds);

        sock.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                connectionStatus = 'DISCONNECTED';
                qrCodeData = await QRCode.toDataURL(qr);
                addLog("Naya QR Code generate ho gaya hai. Please screen par scan karein.", "info");
            }

            if (connection === 'close') {
                const reason = lastDisconnect?.error?.output?.statusCode;
                const shouldReconnect = reason !== DisconnectReason.loggedOut;
                
                connectionStatus = 'DISCONNECTED';
                qrCodeData = null;
                loggedInUser = null;

                addLog(`Connection closed. Reason code: ${reason || 'unknown'}. Reconnecting: ${shouldReconnect}`, "error");
                
                if (shouldReconnect) {
                    connectToWhatsApp();
                } else {
                    // Session wipe-out on manual logout
                    if (fs.existsSync(sessionDir)) {
                        fs.rmSync(sessionDir, { recursive: true, force: true });
                    }
                    addLog("Purana login session remove kar diya gaya hai. Please reload to generate new QR.", "warn");
                }
            } else if (connection === 'open') {
                connectionStatus = 'CONNECTED';
                qrCodeData = null;
                loggedInUser = sock.user.id.split(':')[0];
                addLog(`SUCCESS: WhatsApp successfully connected as ${loggedInUser}`, "success");
            }
        });
    } catch (error) {
        addLog(`Engine Error: ${error.message}`, "error");
    }
}

// Background Bulk Sending Loop
async function processBulkSend(numbersList, message, mediaUrl) {
    if (isSending) return;
    isSending = true;
    systemLogs = []; // Clear old logs on new run
    addLog("Bulk processes successfully triggered on background thread...", "success");

    for (let i = 0; i < numbersList.length; i++) {
        let rawNum = numbersList[i].trim();
        // Remove spaces, dashes and special chars
        let num = rawNum.replace(/[^0-9]/g, '');

        // Add 91 default prefix if it's a 10 digit Indian number
        if (num.length === 10) {
            num = '91' + num;
        }

        if (num.length >= 10) {
            const jid = `${num}@s.whatsapp.net`;
            addLog(`[Queue ${i + 1}/${numbersList.length}]: Sending payload to ${num}...`, "info");

            try {
                if (mediaUrl && mediaUrl.trim() !== "") {
                    // Send with Image Attachment
                    await sock.sendMessage(jid, { 
                        image: { url: mediaUrl.trim() }, 
                        caption: message 
                    });
                } else {
                    // Send text only
                    await sock.sendMessage(jid, { text: message });
                }
                addLog(`✔ Message successfully sent to ${num}`, "success");
            } catch (err) {
                addLog(`❌ Failed for ${num}: ${err.message}`, "error");
            }
        } else {
            addLog(`❌ Skipped: Invalid number structure: ${rawNum}`, "error");
        }

        // Delay interval (10 Seconds)
        if (i < numbersList.length - 1) {
            addLog(`⏳ Safety cooling period... Next execution in 10 seconds.`, "warn");
            await new Promise(resolve => setTimeout(resolve, 10000));
        }
    }

    addLog("🎉 Process Complete: All queue messages processed!", "success");
    isSending = false;
}

// --- API Router Handlers ---

// Fetch real-time status of connection
app.get('/api/status', (req, res) => {
    res.json({
        status: connectionStatus,
        number: loggedInUser,
        qr: qrCodeData,
        isSending: isSending
    });
});

// Fetch background runtime console logs
app.get('/api/logs', (req, res) => {
    res.json({
        logs: systemLogs,
        isSending: isSending
    });
});

// Post bulk message trigger
app.post('/api/send-bulk', (req, res) => {
    if (connectionStatus !== 'CONNECTED') {
        return res.status(400).json({ error: "WhatsApp is not connected." });
    }
    if (isSending) {
        return res.status(400).json({ error: "Another sending process is already active." });
    }

    const { numbers, message, mediaUrl } = req.body;
    if (!numbers || !message) {
        return res.status(400).json({ error: "Required fields missing." });
    }

    const numbersList = numbers.split(',').map(n => n.trim()).filter(n => n.length > 0);
    
    // Non-blocking background flow execution
    processBulkSend(numbersList, message, mediaUrl);

    res.json({ success: true, message: "Queue starting in background..." });
});

// Logout action
app.post('/api/logout', async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Frontend GUI Serving (Dynamic Single-page Dashboard)
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Premium WhatsApp Cloud Sender</title>
        <script src="https://cdn.tailwindcss.com"></script>
        <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0/css/all.min.css" rel="stylesheet">
    </head>
    <body class="bg-slate-950 text-slate-100 min-h-screen font-sans flex flex-col justify-between">

        <!-- Top Header Navigation -->
        <header class="border-b border-slate-800 bg-slate-900/50 backdrop-blur sticky top-0 z-50">
            <div class="max-w-6xl mx-auto px-4 py-4 flex justify-between items-center">
                <div class="flex items-center space-x-3">
                    <div class="bg-emerald-500 text-slate-950 p-2 rounded-xl">
                        <i class="fab fa-whatsapp text-2xl"></i>
                    </div>
                    <div>
                        <h1 class="font-bold text-lg tracking-wide">WA Cloud Gateway</h1>
                        <p class="text-xs text-slate-400">Pure Auto Bulk Sender (Free & Self Hosted)</p>
                    </div>
                </div>
                <div id="topBadge" class="flex items-center space-x-2">
                    <span class="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse"></span>
                    <span class="text-sm text-slate-300">Checking connection status...</span>
                </div>
            </div>
        </header>

        <!-- Main Body Grid System -->
        <main class="max-w-6xl w-full mx-auto px-4 py-8 flex-grow">
            
            <!-- Auth Screen (QR Setup) -->
            <div id="authPanel" class="hidden max-w-md mx-auto bg-slate-900 border border-slate-800 rounded-3xl p-8 shadow-2xl text-center my-12">
                <i class="fas fa-qrcode text-5xl text-emerald-500 mb-4"></i>
                <h2 class="text-2xl font-extrabold mb-2">WhatsApp Account Sync</h2>
                <p class="text-slate-400 text-sm mb-6">Scan karein is QR code ko apne WhatsApp ke Linked Devices section se connect karne ke liye.</p>
                
                <div class="relative bg-white p-4 rounded-2xl inline-block shadow-lg mx-auto mb-6">
                    <img id="qrImage" src="" alt="Scan QR Code" class="w-64 h-64">
                    <div id="qrLoader" class="absolute inset-0 bg-slate-900/90 flex flex-col items-center justify-center rounded-2xl">
                        <div class="animate-spin rounded-full h-10 w-10 border-4 border-emerald-500 border-t-transparent mb-3"></div>
                        <span class="text-sm text-slate-300">Generating fresh secure QR...</span>
                    </div>
                </div>

                <div class="text-xs text-slate-500 flex items-center justify-center space-x-2">
                    <i class="fas fa-lock"></i>
                    <span>Authorized encryption via Whiskeysockets Baileys socket link.</span>
                </div>
            </div>

            <!-- Dashboard Screen (Bulk Controller) -->
            <div id="dashboardPanel" class="hidden grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
                
                <!-- Left Hand Controller (Forms) -->
                <div class="lg:col-span-7 space-y-6">
                    <div class="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-xl">
                        <div class="flex justify-between items-center mb-6">
                            <h3 class="text-xl font-bold flex items-center space-x-2">
                                <i class="fas fa-paper-plane text-emerald-500"></i>
                                <span>Bulk Campaign Dispatcher</span>
                            </h3>
                            <button id="logoutBtn" class="bg-red-500/10 hover:bg-red-500 hover:text-white text-red-400 px-4 py-1.5 rounded-xl text-xs font-semibold transition flex items-center space-x-2">
                                <i class="fas fa-sign-out-alt"></i>
                                <span>Logout Engine</span>
                            </button>
                        </div>

                        <form id="campaignForm" class="space-y-4">
                            <div>
                                <label class="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Phone Numbers (Comma separated with Country Code)</label>
                                <textarea id="numbersInput" required class="w-full h-28 bg-slate-950 border border-slate-800 rounded-2xl px-4 py-3 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500 transition font-mono text-sm" placeholder="919999999999, 918888888888, 917777777777"></textarea>
                                <span class="text-[11px] text-slate-500 mt-1 block">💡 Pro Tip: Country code add karein (India ke liye prefix 91 lagayein).</span>
                            </div>

                            <div>
                                <label class="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Message Content</label>
                                <textarea id="messageInput" required class="w-full h-28 bg-slate-950 border border-slate-800 rounded-2xl px-4 py-3 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500 transition" placeholder="Namaste / Good morning! Kaise hain aap?"></textarea>
                            </div>

                            <div>
                                <label class="block text-xs font-bold uppercase tracking-wider text-slate-400 mb-2">Image / Media Attachment Link (Optional)</label>
                                <div class="relative">
                                    <span class="absolute inset-y-0 left-0 flex items-center pl-4 text-slate-500">
                                        <i class="fas fa-link"></i>
                                    </span>
                                    <input type="url" id="mediaUrlInput" class="w-full bg-slate-950 border border-slate-800 rounded-2xl pl-11 pr-4 py-3 text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500 transition text-sm" placeholder="https://domain.com/path-to-image.jpg">
                                </div>
                                <span class="text-[11px] text-slate-500 mt-1 block">💡 Image directly WhatsApp ke servers se cloud trigger hogi.</span>
                            </div>

                            <button type="submit" id="submitBtn" class="w-full bg-emerald-500 hover:bg-emerald-600 text-slate-950 font-bold py-4 rounded-2xl transition shadow-lg shadow-emerald-500/10 flex items-center justify-center space-x-2">
                                <i class="fas fa-rocket"></i>
                                <span>Start Sending Message Queue</span>
                            </button>
                        </form>
                    </div>
                </div>

                <!-- Right Hand Controller (Live System Logger) -->
                <div class="lg:col-span-5 space-y-6">
                    <div class="bg-slate-900 border border-slate-800 rounded-3xl p-6 shadow-xl flex flex-col h-[525px]">
                        <div class="flex justify-between items-center mb-4">
                            <h3 class="text-lg font-bold flex items-center space-x-2">
                                <i class="fas fa-terminal text-emerald-500"></i>
                                <span>Live Activity Logs</span>
                            </h3>
                            <span id="sendingPulse" class="hidden text-xs bg-emerald-500/10 text-emerald-400 px-3 py-1 rounded-full animate-pulse border border-emerald-500/20 font-semibold">Active Sending</span>
                        </div>

                        <!-- Terminal Output Window -->
                        <div id="logConsole" class="flex-grow bg-slate-950 border border-slate-800 rounded-2xl p-4 overflow-y-auto font-mono text-xs space-y-2 text-slate-300">
                            <!-- Live logs automatically injected here -->
                        </div>
                    </div>
                </div>

            </div>

        </main>

        <!-- Dynamic Status Notification Banners -->
        <div id="toast" class="fixed bottom-6 right-6 bg-slate-900 border border-slate-800 text-slate-200 px-5 py-3 rounded-2xl shadow-2xl flex items-center space-x-3 transform translate-y-24 opacity-0 transition-all duration-300 max-w-sm z-50">
            <span id="toastIcon" class="text-emerald-500"><i class="fas fa-info-circle"></i></span>
            <span id="toastText" class="text-sm">Bhai, message dispatch complete!</span>
        </div>

        <footer class="border-t border-slate-900 py-6 bg-slate-950/50">
            <p class="text-center text-xs text-slate-600">Enterprise Cloud WhatsApp Service © 2026. Made with ❤ for developers.</p>
        </footer>

        <!-- Javascript Flow Automator -->
        <script>
            let currentStatus = '';
            let isCurrentlySending = false;

            // Simple notification handler (No Browser Alert)
            function showToast(message, type = 'info') {
                const toast = document.getElementById('toast');
                const text = document.getElementById('toastText');
                const icon = document.getElementById('toastIcon');

                text.innerText = message;
                if(type === 'success') {
                    icon.innerHTML = '<i class="fas fa-check-circle text-emerald-500"></i>';
                } else if(type === 'error') {
                    icon.innerHTML = '<i class="fas fa-exclamation-triangle text-red-500"></i>';
                } else {
                    icon.innerHTML = '<i class="fas fa-info-circle text-amber-500"></i>';
                }

                toast.classList.remove('translate-y-24', 'opacity-0');
                setTimeout(() => {
                    toast.classList.add('translate-y-24', 'opacity-0');
                }, 4000);
            }

            // Realtime API status checker (Polls every 2 seconds)
            async function checkStatus() {
                try {
                    const res = await fetch('/api/status');
                    const data = await res.json();

                    // UI Badges handler
                    const badge = document.getElementById('topBadge');
                    if(data.status === 'CONNECTED') {
                        badge.innerHTML = \`<span class="w-2.5 h-2.5 rounded-full bg-emerald-500"></span><span class="text-sm font-semibold text-emerald-400">Connected: \${data.number}</span>\`;
                        document.getElementById('authPanel').classList.add('hidden');
                        document.getElementById('dashboardPanel').classList.remove('hidden');
                    } else if(data.status === 'CONNECTING') {
                        badge.innerHTML = \`<span class="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse"></span><span class="text-sm text-amber-400 font-semibold">Authenticating Engine...</span>\`;
                    } else {
                        badge.innerHTML = \`<span class="w-2.5 h-2.5 rounded-full bg-red-500 animate-pulse"></span><span class="text-sm text-red-400 font-semibold">Session Disconnected</span>\`;
                        document.getElementById('dashboardPanel').classList.add('hidden');
                        document.getElementById('authPanel').classList.remove('hidden');

                        // Manage QR loader visibility
                        const qrLoader = document.getElementById('qrLoader');
                        const qrImage = document.getElementById('qrImage');
                        if (data.qr) {
                            qrLoader.classList.add('hidden');
                            qrImage.src = data.qr;
                        } else {
                            qrLoader.classList.remove('hidden');
                            qrImage.src = '';
                        }
                    }

                    currentStatus = data.status;
                } catch(err) {
                    console.error("Health check failure:", err);
                }
            }

            // Terminal Logs checker (Polls every 1.5 seconds)
            async function checkLogs() {
                try {
                    const res = await fetch('/api/logs');
                    const data = await res.json();

                    const logConsole = document.getElementById('logConsole');
                    const activePulse = document.getElementById('sendingPulse');
                    const submitBtn = document.getElementById('submitBtn');

                    // Check if sending state changed
                    if(data.isSending) {
                        activePulse.classList.remove('hidden');
                        submitBtn.disabled = true;
                        submitBtn.classList.add('opacity-50', 'cursor-not-allowed');
                        submitBtn.innerHTML = '<i class="fas fa-spinner animate-spin"></i><span>Sending In Progress (10s Delay Active)...</span>';
                    } else {
                        activePulse.classList.add('hidden');
                        submitBtn.disabled = false;
                        submitBtn.classList.remove('opacity-50', 'cursor-not-allowed');
                        submitBtn.innerHTML = '<i class="fas fa-rocket"></i><span>Start Sending Message Queue</span>';
                    }

                    // Format and render raw terminal logs
                    logConsole.innerHTML = data.logs.map(log => {
                        let colorClass = 'text-slate-300';
                        if(log.type === 'success') colorClass = 'text-emerald-400 font-bold';
                        if(log.type === 'error') colorClass = 'text-red-400 font-bold';
                        if(log.type === 'warn') colorClass = 'text-amber-400';
                        return \`<div class="\${colorClass}">[\${log.time}] \${log.message}</div>\`;
                    }).join('');

                    // Scroll console to bottom
                    logConsole.scrollTop = logConsole.scrollHeight;
                } catch(err) {
                    console.error("Log fetch failure:", err);
                }
            }

            // Submit form for bulk dispatcher
            document.getElementById('campaignForm').addEventListener('submit', async (e) => {
                e.preventDefault();
                const numbers = document.getElementById('numbersInput').value;
                const message = document.getElementById('messageInput').value;
                const mediaUrl = document.getElementById('mediaUrlInput').value;

                try {
                    const res = await fetch('/api/send-bulk', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ numbers, message, mediaUrl })
                    });
                    const result = await res.json();

                    if(result.success) {
                        showToast("Campaign Successfully Dispatched!", "success");
                    } else {
                        showToast(result.error || "System rejected dispatch command.", "error");
                    }
                } catch(err) {
                    showToast("Network failure inside system pipeline.", "error");
                }
            });

            // Logout action button trigger
            document.getElementById('logoutBtn').addEventListener('click', async () => {
                if(!confirm("Bhai, kya aap sach me disconnect karna chahte ho?")) return;
                try {
                    const res = await fetch('/api/logout', { method: 'POST' });
                    const result = await res.json();
                    if(result.success) {
                        showToast("Account successfully unlinked.", "info");
                        window.location.reload();
                    }
                } catch(err) {
                    showToast("Logout action failed.", "error");
                }
            });

            // Set continuous system pollers
            setInterval(checkStatus, 2000);
            setInterval(checkLogs, 1500);

            // Initial immediate triggers
            checkStatus();
            checkLogs();
        </script>
    </body>
    </html>
    `);
});

// App initiation trigger
app.listen(port, () => {
    console.log(`API Gateway Server initialized on port: ${port}`);
    // Non blocking auth start on init
    connectToWhatsApp();
});
