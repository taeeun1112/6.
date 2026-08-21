const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const { createClient } = require('@supabase/supabase-js');

const PORT = process.env.PORT || 3000;
const POSITION_API_URL = 'https://position-api-generator.onrender.com/api/state';

// Supabase Configuration (https://ebbkanusdggvhgbjxteb.supabase.co)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ebbkanusdggvhgbjxteb.supabase.co';
let SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_NOp-io1PGhFeHsHC11FOgg_QPRfAPrS';
let supabase = null;

if (SUPABASE_ANON_KEY) {
    try {
        supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
        console.log(`[Supabase] Initialized with URL: ${SUPABASE_URL}`);
    } catch (e) {
        console.warn(`[Supabase Warning] Failed to initialize Supabase client:`, e.message);
    }
}

// Enable CORS for external connections (TouchDesigner & external web clients)
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

// Middleware for parsing JSON and raw binary data (up to 50mb for high-res camera frames)
app.use(express.json({ limit: '50mb' }));
app.use(express.raw({ type: ['image/*', 'application/octet-stream'], limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Serve static frontend files
app.use(express.static(path.join(__dirname)));

// Global Telemetry & Frame State
let latestState = {
    x: 2500,
    y: 2500,
    rotation: 0,
    speed: 0,
    action: 4,
    cameraActive: false,
    lastUpdated: Date.now()
};

let lastApiState = { x: 2500, y: 2500, time: Date.now() };
let lastTdTelemetryTime = 0;
let lastTdFrameTime = 0;

// Utility: Broadcast data to all connected WebSocket clients (Browsers & TouchDesigner)
function broadcast(data, isBinary = false, sender = null) {
    wss.clients.forEach((client) => {
        if (client !== sender && client.readyState === WebSocket.OPEN) {
            client.send(data, { binary: isBinary });
        }
    });
}

// =========================================================================
// WEBSOCKET HANDLER (TouchDesigner & Web UI clients)
// =========================================================================
wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress;
    console.log(`[WS] New client connected from ${clientIp}. Total clients: ${wss.clients.size}`);

    // Send current initial state on connection
    ws.send(JSON.stringify({
        type: 'telemetry',
        speed: latestState.speed,
        rotation: latestState.rotation,
        x: latestState.x,
        y: latestState.y,
        action: latestState.action,
        cameraActive: latestState.cameraActive
    }));

    ws.on('message', (message, isBinary) => {
        if (isBinary) {
            // TouchDesigner sending raw binary JPEG/PNG camera frame
            lastTdFrameTime = Date.now();
            latestState.cameraActive = true;
            latestState.lastUpdated = Date.now();
            
            // Broadcast raw binary frame directly to browser clients
            broadcast(message, true, ws);
        } else {
            // Text / JSON Message
            try {
                const str = message.toString();
                
                // Handle raw Base64 image string from TouchDesigner DAT
                if (str.startsWith('data:image/') || (str.length > 500 && !str.startsWith('{'))) {
                    lastTdFrameTime = Date.now();
                    latestState.cameraActive = true;
                    latestState.lastUpdated = Date.now();

                    const framePayload = JSON.stringify({
                        type: 'frame',
                        image: str.startsWith('data:image/') ? str : `data:image/jpeg;base64,${str}`
                    });
                    broadcast(framePayload, false, ws);
                    return;
                }

                const data = JSON.parse(str);

                // TouchDesigner camera frame JSON message
                if (data.type === 'frame' || data.image || data.blob) {
                    lastTdFrameTime = Date.now();
                    latestState.cameraActive = true;
                    latestState.lastUpdated = Date.now();

                    const framePayload = JSON.stringify({
                        type: 'frame',
                        image: data.image || data.blob || data.data
                    });
                    broadcast(framePayload, false, ws);
                }
                // TouchDesigner telemetry JSON message
                else if (data.type === 'telemetry' || data.x !== undefined || data.speed !== undefined) {
                    lastTdTelemetryTime = Date.now();
                    
                    if (data.speed !== undefined) latestState.speed = Number(data.speed);
                    if (data.rotation !== undefined) latestState.rotation = Number(data.rotation);
                    if (data.x !== undefined) latestState.x = Number(data.x);
                    if (data.y !== undefined) latestState.y = Number(data.y);
                    if (data.action !== undefined) latestState.action = Number(data.action);
                    latestState.cameraActive = (Date.now() - lastTdFrameTime < 3000);
                    latestState.lastUpdated = Date.now();

                    const telemetryPayload = JSON.stringify({
                        type: 'telemetry',
                        speed: latestState.speed,
                        rotation: latestState.rotation,
                        x: latestState.x,
                        y: latestState.y,
                        action: latestState.action,
                        cameraActive: latestState.cameraActive
                    });
                    broadcast(telemetryPayload, false, ws);
                } else {
                    // Forward any generic messages
                    broadcast(str, false, ws);
                }
            } catch (err) {
                console.error('[WS Error] Error parsing text frame:', err.message);
            }
        }
    });

    ws.on('close', () => {
        console.log(`[WS] Client disconnected. Remaining clients: ${wss.clients.size}`);
    });

    ws.on('error', (err) => {
        console.error('[WS Error]', err);
    });
});

// =========================================================================
// HTTP POST ENDPOINTS (TouchDesigner HTTP Web DAT support)
// =========================================================================

// HTTP Camera Frame Push Endpoint (e.g. POST /api/frame or /api/camera)
app.post(['/api/frame', '/api/camera'], (req, res) => {
    lastTdFrameTime = Date.now();
    latestState.cameraActive = true;
    latestState.lastUpdated = Date.now();

    if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        // Raw binary JPEG/PNG body
        broadcast(req.body, true);
        return res.json({ success: true, mode: 'binary', bytes: req.body.length });
    } else if (req.body && (req.body.image || req.body.frame || req.body.data)) {
        // JSON Base64 body
        const img = req.body.image || req.body.frame || req.body.data;
        const framePayload = JSON.stringify({
            type: 'frame',
            image: img.startsWith('data:image/') ? img : `data:image/jpeg;base64,${img}`
        });
        broadcast(framePayload, false);
        return res.json({ success: true, mode: 'json' });
    } else {
        return res.status(400).json({ error: 'No image frame data received' });
    }
});

// HTTP Telemetry Push Endpoint
app.post(['/api/telemetry', '/api/state'], (req, res) => {
    const data = req.body;
    lastTdTelemetryTime = Date.now();

    if (data.speed !== undefined) latestState.speed = Number(data.speed);
    if (data.rotation !== undefined) latestState.rotation = Number(data.rotation);
    if (data.x !== undefined) latestState.x = Number(data.x);
    if (data.y !== undefined) latestState.y = Number(data.y);
    if (data.action !== undefined) latestState.action = Number(data.action);
    latestState.cameraActive = (Date.now() - lastTdFrameTime < 3000);
    latestState.lastUpdated = Date.now();

    const telemetryPayload = JSON.stringify({
        type: 'telemetry',
        speed: latestState.speed,
        rotation: latestState.rotation,
        x: latestState.x,
        y: latestState.y,
        action: latestState.action,
        cameraActive: latestState.cameraActive
    });
    broadcast(telemetryPayload);

    res.json({ success: true, state: latestState });
});

// GET Current State Endpoint
app.get('/api/state', (req, res) => {
    res.json(latestState);
});

// Supabase Status & Dynamic Key Config Endpoints
app.get('/api/supabase', (req, res) => {
    res.json({
        url: SUPABASE_URL,
        connected: !!supabase,
        hasKey: !!SUPABASE_ANON_KEY
    });
});

app.post('/api/supabase/config', (req, res) => {
    const { key } = req.body;
    if (key) {
        SUPABASE_ANON_KEY = key;
        try {
            supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
            console.log(`[Supabase] Updated client with new API Key.`);
            return res.json({ success: true, message: 'Supabase client connected successfully!' });
        } catch (e) {
            return res.status(400).json({ error: e.message });
        }
    }
    res.status(400).json({ error: 'API key is required' });
});

// =========================================================================
// POSITION API GENERATOR POLLING (https://position-api-generator.onrender.com)
// =========================================================================
async function pollPositionApiGenerator() {
    // Skip external API polling if TouchDesigner is actively sending custom telemetry (< 2s ago)
    if (Date.now() - lastTdTelemetryTime < 2000) {
        return;
    }

    try {
        const response = await fetch(POSITION_API_URL, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) return;
        const data = await response.json();

        const now = Date.now();
        const dt = Math.max((now - lastApiState.time) / 1000, 0.05);

        // Calculate speed based on movement delta
        const dx = (data.x !== undefined ? data.x : lastApiState.x) - lastApiState.x;
        const dy = (data.y !== undefined ? data.y : lastApiState.y) - lastApiState.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Convert distance delta to speed (km/h scale)
        let calculatedSpeed = Math.min(60, (dist / dt) * 0.05);
        if (data.speed !== undefined) {
            calculatedSpeed = Number(data.speed);
        }

        // Smooth speed transitions
        latestState.speed += (calculatedSpeed - latestState.speed) * 0.25;
        if (latestState.speed < 0.5) latestState.speed = 0;

        if (data.rotation !== undefined) latestState.rotation = Number(data.rotation);
        if (data.x !== undefined) latestState.x = Number(data.x);
        if (data.y !== undefined) latestState.y = Number(data.y);
        if (data.action !== undefined) latestState.action = Number(data.action);
        
        latestState.cameraActive = (Date.now() - lastTdFrameTime < 3000);
        latestState.lastUpdated = now;

        lastApiState = { x: latestState.x, y: latestState.y, time: now };

        // Broadcast updated telemetry to browsers & TouchDesigner
        const telemetryPayload = JSON.stringify({
            type: 'telemetry',
            speed: latestState.speed,
            rotation: latestState.rotation,
            x: latestState.x,
            y: latestState.y,
            action: latestState.action,
            cameraActive: latestState.cameraActive
        });
        broadcast(telemetryPayload);
    } catch (err) {
        // Silently handle transient network timeouts or fetch errors
    }
}

// Poll API generator 10 times per second (every 100ms)
setInterval(pollPositionApiGenerator, 100);

// Start Server with fallback port support
function startServer(portToUse) {
    server.listen(portToUse, () => {
        console.log(`=======================================================`);
        console.log(`🚀 SNS TouchDesigner Server running on http://localhost:${portToUse}`);
        console.log(`📡 WebSocket endpoint: ws://localhost:${portToUse}`);
        console.log(`📷 HTTP Frame Upload: POST http://localhost:${portToUse}/api/frame`);
        console.log(`🌐 Synchronized with: ${POSITION_API_URL}`);
        console.log(`=======================================================`);
    });
}

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        const nextPort = Number(PORT) + 1;
        console.warn(`[Port Busy] Port ${PORT} is in use. Trying port ${nextPort}...`);
        startServer(nextPort);
    } else {
        console.error('[Server Error]', err);
    }
});

startServer(PORT);
