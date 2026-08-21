/**
 * Mobility SNS — Full Telemetry Integration
 *
 * Data → Function Mappings:
 *  SPEED  → auto-scroll speed · mosaic pixel size · OFFLINE↔LIVE toggle
 *  STEER  → scroll direction · Ishihara palette hue-shift
 *  GPS    → post location tag (simulated from speed/steer integral)
 *  DIST/AVG SPEED → auto completed-ride card on ride end
 *  DURATION → real-time like/comment count grows with ride time
 */

document.addEventListener('DOMContentLoaded', () => {

    // =========================================================================
    // STATE
    // =========================================================================
    let state = {
        speed: 0,               // km/h  (0–60)
        rotation: 0,            // degrees (-90 to 90)
        isOperating: false,     // engine on/off (starts stopped at 0 km/h)
        currentScrollSpeed: 0,  // inertia for scroll
        lastTime: performance.now(),

        // Ride telemetry
        rideStartTime: null,    // Date.now() when ride went LIVE
        rideDurationSec: 0,     // seconds since LIVE started
        totalDistanceKm: 0,     // accumulated km (speed × dt integral)
        speedSamples: [],       // for avg speed calculation
        wasLive: false,         // true once speed exceeded LIVE threshold

        // GPS simulation (bearing integration)
        gpsBearing: 0,          // cumulative heading (degrees)
        gpsLat: 37.5665,        // starting lat (Seoul)
        gpsLon: 126.9780,       // starting lon

        // Reaction counters
        baseLikes: 1203,
        baseComments: 88,
        baseShares: 24,

        // Hue shift for Ishihara palette (degrees, 0–360)
        paletteHueShift: 0,

        // Completed card shown once per ride session
        completedCardShown: false,

        // Manual slider override flag
        manualOverride: false,

        // Simulator manual override
        simManualOverride: false,

        // Heart spawn accumulator
        heartAccumulator: 0,

        // Last telemetry sampling timestamp
        lastSampleTime: 0,
    };

    // =========================================================================
    // DOM BINDINGS
    // =========================================================================
    const simIsland          = document.getElementById('sim-island');
    const islandTrigger      = document.getElementById('island-trigger');
    const btnIslandMinimize  = document.getElementById('btn-island-minimize');
    const simBtnPower        = document.getElementById('sim-btn-power');
    const simInputSpeed      = document.getElementById('sim-input-speed');
    const simInputRotation   = document.getElementById('sim-input-rotation');
    const simValSpeed        = document.getElementById('sim-val-speed');
    const simValRotation     = document.getElementById('sim-val-rotation');
    const islandStatSpeed    = document.getElementById('island-stat-speed');
    const islandStatRot      = document.getElementById('island-stat-rot');
    const overlaySpeed       = document.getElementById('overlay-speed');
    const overlayRotation    = document.getElementById('overlay-rotation');
    const overlayStatusIndicator = document.getElementById('overlay-status-indicator');
    const simPresetCruise    = document.getElementById('sim-preset-cruise');
    const simPresetCurve     = document.getElementById('sim-preset-curve');
    const simPresetStop      = document.getElementById('sim-preset-stop');

    // Canvas & Media
    const particleCanvas     = document.getElementById('riding-particles-canvas');
    const pCtx               = particleCanvas?.getContext('2d');
    const mosaicCanvas       = document.getElementById('mosaic-canvas');
    const mosaicCtx          = mosaicCanvas?.getContext('2d');
    const cameraVideo        = document.getElementById('camera-video');
    const passengerMedia     = document.getElementById('passenger-media-container');
    const leftGlow           = document.getElementById('left-steer-glow');
    const rightGlow          = document.getElementById('right-steer-glow');
    const cameraPermOverlay  = document.getElementById('camera-permission-overlay');
    const btnRequestCamera   = document.getElementById('btn-request-camera');
    const mosaicSlider       = document.getElementById('mosaic-intensity');
    const mosaicValDisplay   = document.getElementById('mosaic-val');
    const mosaicControlBadge = document.getElementById('mosaic-control-badge');
    const mosaicSpeedIndicator = document.getElementById('mosaic-speed-indicator');
    const mosaicSpeedPx      = document.getElementById('mosaic-speed-px');
    const feedMainLayout     = document.getElementById('fb-center-feed');

    // Reaction counters
    const likeCountNum       = document.getElementById('like-count-num');
    const commentCountNum    = document.getElementById('comment-count-num');
    const shareCountNum      = document.getElementById('share-count-num');

    // Location & completed card
    const postLocationTag    = document.getElementById('post-location-tag');
    const completedCard      = document.getElementById('completed-ride-card');
    const completedLocName   = document.getElementById('completed-location-name');
    const completedRouteName = document.getElementById('completed-route-name');
    const completedStats     = document.getElementById('completed-stats');
    const completedCaption   = document.getElementById('completed-caption');
    const completedTimestamp = document.getElementById('completed-timestamp');

    // Infographic elements (removed as requested)
    const btnLikePost        = document.getElementById('btn-like-post');

    // =========================================================================
    // CLOCK
    // =========================================================================
    function updateClock() {
        const now = new Date();
        const hrs = now.getHours();
        const mins = String(now.getMinutes()).padStart(2, '0');
        
        // Update iPhone status bar time
        const iosTime = document.getElementById('ios-time');
        if (iosTime) {
            iosTime.textContent = `${hrs}:${mins}`;
        }

        // Update standard clock if any
        const el = document.getElementById('current-time');
        if (el) {
            let h = hrs;
            const ampm = h >= 12 ? 'PM' : 'AM';
            h = h % 12 || 12;
            el.textContent = `${h}:${mins} ${ampm}`;
        }
    }
    setInterval(updateClock, 1000);
    updateClock();

    // =========================================================================
    // GPS SIMULATION
    // Integrates speed + steer to compute a synthetic position and named zone.
    // =========================================================================
    const LOCATION_ZONES = [
        { name: '서울예술대학교 남산캠퍼스 심재순관', lat: 37.551, lon: 126.988 },
        { name: 'Yeouido Bridge 🌙',     lat: 37.527, lon: 126.930 },
        { name: 'Banpo Han River Park 🌿', lat: 37.512, lon: 126.997 },
        { name: 'Olympic Park ⚡',       lat: 37.520, lon: 127.124 },
        { name: 'Ttukseom Resort 🛶',    lat: 37.530, lon: 127.068 },
        { name: 'Gwanghwamun Plaza 🏛',  lat: 37.576, lon: 126.977 },
        { name: 'Dongdaemun Design 🎨',  lat: 37.566, lon: 127.009 },
        { name: 'Hongdae Street 🎵',     lat: 37.557, lon: 126.925 },
        { name: 'Gangnam District 🏙',   lat: 37.498, lon: 127.027 },
        { name: 'Namsan Tower 🗼',       lat: 37.551, lon: 126.988 },
    ];

    let currentZoneIndex = 0;
    let lastGpsUpdateTime = 0;

    function updateGPS(deltaTime) {
        if (!state.isOperating || state.speed <= 0) return;

        // Advance bearing based on steer (rotation maps to heading change)
        state.gpsBearing = (state.gpsBearing + state.rotation * 0.01 * deltaTime * 60) % 360;

        // Convert speed to distance increment (km per second)
        const distIncrement = (state.speed / 3600) * deltaTime;
        state.totalDistanceKm += distIncrement;

        // Move simulated lat/lon
        const bearingRad = (state.gpsBearing * Math.PI) / 180;
        state.gpsLat += Math.cos(bearingRad) * distIncrement * 0.009;
        state.gpsLon += Math.sin(bearingRad) * distIncrement * 0.009;

        // Change location zone every ~0.5 km or every 12 seconds
        const now = Date.now();
        if (state.totalDistanceKm > 0 &&
            (Math.floor(state.totalDistanceKm / 0.5) > currentZoneIndex ||
             now - lastGpsUpdateTime > 12000)) {
            currentZoneIndex = Math.floor(state.totalDistanceKm / 0.5) % LOCATION_ZONES.length;
            lastGpsUpdateTime = now;
            updateLocationTag();
        }
    }

    function updateLocationTag() {
        const zone = LOCATION_ZONES[currentZoneIndex];
        if (postLocationTag) {
            postLocationTag.textContent = `${zone.name}`;
            postLocationTag.style.display = 'inline';
            // Flash animation
            postLocationTag.style.opacity = '0';
            setTimeout(() => { postLocationTag.style.opacity = '1'; }, 50);
        }
    }

    // =========================================================================
    // CAMERA + ISHIHARA MOSAIC
    // =========================================================================
    let mosaicPixelSize = 6; /* Fixed smallest circular pixel size */
    let cameraActive    = false;
    let mosaicAnimFrame = null;
    let frameCount      = 0;

    // Shared Camera Receiver variables
    let sharedFrameImage = null;
    let isUsingSharedCamera = false;
    let lastFrameReceivedTime = 0;
    let isUsingSharedTelemetry = false;
    let lastTelemetryReceivedTime = 0;

    const offCanvas = document.createElement('canvas');
    const offCtx    = offCanvas.getContext('2d');

    function resizeCanvas() {
        if (particleCanvas && passengerMedia) {
            particleCanvas.width  = passengerMedia.clientWidth;
            particleCanvas.height = passengerMedia.clientHeight;
        }
        if (mosaicCanvas && passengerMedia) {
            mosaicCanvas.width  = passengerMedia.clientWidth;
            mosaicCanvas.height = passengerMedia.clientHeight;
        }
    }
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    if (window.ResizeObserver && passengerMedia) {
        const ro = new ResizeObserver(() => {
            resizeCanvas();
        });
        ro.observe(passengerMedia);
    }

    /** Speed → foreground pixel size (6–36px). Inverted: fast speed = fine pixels (6px), slow = coarse (36px) */
    function speedToMosaicSize(speed) {
        const minPx = 6, maxPx = 36;
        // Reach maximum clarity (6px) at 25 km/h instead of 60 km/h
        // Linear transition for responsive and clear visual feedback during active riding
        const eased = Math.min(1, speed / 25);
        return Math.round(maxPx - eased * (maxPx - minPx));
    }

    // ---- ISHIHARA PALETTES (Thermal sorted from dark to bright) ----
    const COLD_PALETTE = [
        [30,  58,  138], // navy/blue (darkest)
        [29,  78,  216], // blue
        [59,  130, 246], // light blue
        [16,  185, 129], // emerald green
        [34,  197, 94 ], // vivid green
        [132, 204, 22 ]  // lime green (brightest)
    ];

    const MID_PALETTE = [
        [217, 119, 6  ], // dark amber (darkest)
        [249, 115, 22 ], // orange
        [245, 158, 11 ], // amber
        [251, 146, 60 ], // peach orange
        [234, 179, 8  ], // yellow
        [250, 204, 21 ]  // light yellow (brightest)
    ];

    const HOT_PALETTE = [
        [153, 27,  27 ], // dark red (darkest)
        [220, 38,  38 ], // red
        [225, 29,  72 ], // rose
        [239, 68,  68 ], // coral red
        [254, 226, 226], // light pink/white
        [255, 255, 255]  // pure white (brightest)
    ];

    // Interpolates through thermal imaging gradient based on speed: Cold (Blue/Green) -> Mid (Yellow/Orange) -> Hot (Red/White)
    function getSpeedInterpolatedPalette(speed) {
        const palette = [];
        if (speed <= 18) {
            // Speed <= 18 km/h: Full cold blue/green (covers the low end of simulated riding 16 km/h)
            return COLD_PALETTE;
        } else if (speed <= 26) {
            // Speed 18 to 26 km/h: Transition from COLD (blue/green) to MID (yellow/orange)
            const t = (speed - 18) / 8;
            for (let i = 0; i < COLD_PALETTE.length; i++) {
                const r = Math.round(COLD_PALETTE[i][0] + t * (MID_PALETTE[i][0] - COLD_PALETTE[i][0]));
                const g = Math.round(COLD_PALETTE[i][1] + t * (MID_PALETTE[i][1] - COLD_PALETTE[i][1]));
                const b = Math.round(COLD_PALETTE[i][2] + t * (MID_PALETTE[i][2] - COLD_PALETTE[i][2]));
                palette.push([r, g, b]);
            }
        } else if (speed <= 32) {
            // Speed 26 to 32 km/h: Transition from MID (yellow/orange) to HOT (red/white)
            const t = (speed - 26) / 6;
            for (let i = 0; i < MID_PALETTE.length; i++) {
                const r = Math.round(MID_PALETTE[i][0] + t * (HOT_PALETTE[i][0] - MID_PALETTE[i][0]));
                const g = Math.round(MID_PALETTE[i][1] + t * (HOT_PALETTE[i][1] - MID_PALETTE[i][1]));
                const b = Math.round(MID_PALETTE[i][2] + t * (HOT_PALETTE[i][2] - MID_PALETTE[i][2]));
                palette.push([r, g, b]);
            }
        } else {
            // Speed > 32 km/h: Full hot red/white (covers the high end of simulated riding 33 km/h)
            return HOT_PALETTE;
        }
        return palette;
    }

    // Pure cold-toned blue/purple/slate BG palette
    const BG_PALETTE = [
        [15,  23,  42 ], // slate 900
        [30,  41,  59 ], // slate 800
        [29,  78,  216], // blue 700
        [67,  56,  202], // indigo 700
        [109, 40,  217], // purple 700
        [71,  85,  105], // slate 600
        [148, 163, 184], // slate 400
    ];

    /**
     * Apply hue rotation to an RGB color (in degrees).
     * Uses matrix rotation in RGB space (approximate but fast).
     */
    function rotateHue(r, g, b, angleDeg) {
        if (angleDeg === 0) return [r, g, b];
        const cos = Math.cos(angleDeg * Math.PI / 180);
        const sin = Math.sin(angleDeg * Math.PI / 180);
        const nr = Math.min(255, Math.max(0, Math.round(
            r * (0.213 + cos * 0.787 - sin * 0.213) +
            g * (0.715 - cos * 0.715 - sin * 0.715) +
            b * (0.072 - cos * 0.072 + sin * 0.928)
        )));
        const ng = Math.min(255, Math.max(0, Math.round(
            r * (0.213 - cos * 0.213 + sin * 0.143) +
            g * (0.715 + cos * 0.285 + sin * 0.140) +
            b * (0.072 - cos * 0.072 - sin * 0.283)
        )));
        const nb = Math.min(255, Math.max(0, Math.round(
            r * (0.213 - cos * 0.213 - sin * 0.787) +
            g * (0.715 - cos * 0.715 + sin * 0.715) +
            b * (0.072 + cos * 0.928 + sin * 0.072)
        )));
        return [nr, ng, nb];
    }

    function buildFgPalette() {
        const basePalette = getSpeedInterpolatedPalette(state.speed);
        // steer -90..90 → hue shift -60..+60 degrees
        const hue = state.paletteHueShift;
        return basePalette.map(([r, g, b]) => rotateHue(r, g, b, hue));
    }

    /** Nearest-colour quantization. */
    function quantize(r, g, b, palette) {
        let bestDist = Infinity, best = palette[0];
        for (const col of palette) {
            const d = (r-col[0])**2 + (g-col[1])**2 + (b-col[2])**2;
            if (d < bestDist) { bestDist = d; best = col; }
        }
        return best;
    }

    /**
     * Elliptical foreground zone — centre-weighted person area.
     * Returns 0 (background) .. 1 (fully foreground).
     */
    function getForegroundness(x, y, W, H) {
        const cx = W / 2, cy = H * 0.52;
        const dx = (x - cx) / (W * 0.50);
        const dy = (y - cy) / (H * 0.50);
        return Math.max(0, Math.min(1, 1 - Math.sqrt(dx*dx + dy*dy)));
    }

    // Load Human Interfaced Poster Image
    const posterImage = new Image();
    let posterLoaded = false;
    posterImage.onload = () => {
        posterLoaded = true;
        if (mosaicControlBadge) {
            mosaicControlBadge.style.opacity = '1';
            mosaicControlBadge.style.pointerEvents = 'auto';
        }
        if (mosaicSpeedIndicator) mosaicSpeedIndicator.classList.add('visible');
        const legend = document.getElementById('ishihara-legend');
        if (legend) legend.classList.add('visible');
        if (!mosaicAnimFrame) {
            renderMosaicFrame();
        }
    };
    posterImage.src = 'assets/poster.jpg';

    /**
     * Dual-zone Ishihara mosaic render:
     * - Person zone: large warm-tone pixels (hue shifts with steer)
     * - Background: small pure-grayscale pixels
     */
    function renderMosaicFrame() {
        if (!isUsingSharedCamera && !posterLoaded && (!cameraActive || !cameraVideo || cameraVideo.readyState < 2)) {
            mosaicAnimFrame = requestAnimationFrame(renderMosaicFrame);
            return;
        }
        if (isUsingSharedCamera && !sharedFrameImage) {
            mosaicAnimFrame = requestAnimationFrame(renderMosaicFrame);
            return;
        }

        frameCount++;
        const W = mosaicCanvas.width;
        const H = mosaicCanvas.height;

        // Pixel sizes — 5:1 ratio for dramatic zone contrast
        const fgBase = mosaicPixelSize;
        const bgBase = Math.max(4, Math.round(fgBase * 0.20));

        // ±1px jitter (live masking feel)
        const jitter   = Math.sin(frameCount * 0.05);
        const fgPixSize = Math.max(8, Math.round(fgBase + jitter));
        const bgPixSize = Math.max(4, Math.round(bgBase + jitter * 0.3));

        const cols = Math.ceil(W / bgPixSize);
        const rows = Math.ceil(H / bgPixSize);

        // Resize offCanvas ONLY when dimensions change
        if (offCanvas.width !== cols || offCanvas.height !== rows) {
            offCanvas.width = cols;
            offCanvas.height = rows;
        }

        // Downscale frame natively via drawImage (TouchDesigner > Poster > Camera)
        if (isUsingSharedCamera && sharedFrameImage) {
            offCtx.drawImage(sharedFrameImage, 0, 0, cols, rows);
        } else if (posterLoaded) {
            offCtx.drawImage(posterImage, 0, 0, cols, rows);
        } else if (cameraVideo && cameraVideo.readyState >= 2) {
            offCtx.drawImage(cameraVideo, 0, 0, cols, rows);
        }

        let imageData;
        try {
            imageData = offCtx.getImageData(0, 0, cols, rows);
        } catch(e) {
            mosaicAnimFrame = requestAnimationFrame(renderMosaicFrame);
            return;
        }
        const data = imageData.data;

        // Clear with pure black gap
        mosaicCtx.fillStyle = '#000';
        mosaicCtx.fillRect(0, 0, W, H);

        // Build hue-shifted FG palette (steer-driven)
        const FG_PALETTE = buildFgPalette();
        const gap = 1;

        // Coordinate-stable hash for Ishihara dots
        function hashCoords(cx, cy) {
            const val = Math.sin(cx * 12.9898 + cy * 78.233) * 43758.5453;
            return val - Math.floor(val);
        }

        // Group background draw commands by color index
        const bgDrawGroups = Array.from({ length: BG_PALETTE.length }, () => []);

        // BG pass — cold-toned small circles
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const x = c * bgPixSize;
                const y = r * bgPixSize;
                const cx = x + bgPixSize / 2;
                const cy = y + bgPixSize / 2;
                const fg = getForegroundness(cx, cy, W, H);
                if (fg > 0.5) continue;

                // Direct array lookup from downscaled image
                const i = (r * cols + c) * 4;
                const rr = data[i];
                const gg = data[i+1];
                const bb = data[i+2];

                const bestColor = quantize(rr, gg, bb, BG_PALETTE);
                const colorIdx = BG_PALETTE.indexOf(bestColor);
                if (colorIdx !== -1) {
                    const stableRand = hashCoords(c, r);
                    const sizeRatio = 0.4 + stableRand * 0.6;
                    const radius = Math.max(1, ((bgPixSize - gap * 2) / 2) * sizeRatio);
                    bgDrawGroups[colorIdx].push({ cx, cy, radius });
                }
            }
        }

        // Draw background circles color-grouped
        for (let idx = 0; idx < BG_PALETTE.length; idx++) {
            const list = bgDrawGroups[idx];
            if (list.length === 0) continue;
            const [qr, qg, qb] = BG_PALETTE[idx];
            mosaicCtx.fillStyle = `rgb(${qr},${qg},${qb})`;
            mosaicCtx.beginPath();
            for (let j = 0; j < list.length; j++) {
                const item = list[j];
                mosaicCtx.moveTo(item.cx + item.radius, item.cy);
                mosaicCtx.arc(item.cx, item.cy, item.radius, 0, Math.PI * 2);
            }
            mosaicCtx.fill();
        }

        // FG pass — speed-coded thermal circles mapped from luminance
        const colsFg = Math.ceil(W / fgPixSize);
        const rowsFg = Math.ceil(H / fgPixSize);

        // Group foreground draw commands by color & alpha key
        const fgDrawGroups = {};

        for (let r = 0; r < rowsFg; r++) {
            for (let c = 0; c < colsFg; c++) {
                const x = c * fgPixSize;
                const y = r * fgPixSize;
                const cx = x + fgPixSize / 2;
                const cy = y + fgPixSize / 2;
                const fg = getForegroundness(cx, cy, W, H);
                if (fg < 0.15) continue;

                // Sample from downscaled background data
                const bgC = Math.min(cols - 1, Math.floor((cx / W) * cols));
                const bgR = Math.min(rows - 1, Math.floor((cy / H) * rows));
                const i = (bgR * cols + bgC) * 4;

                const rr = data[i];
                const gg = data[i+1];
                const bb = data[i+2];

                const lum = (rr * 0.299 + gg * 0.587 + bb * 0.114) / 255;
                const colorIdx = Math.min(5, Math.floor(lum * 6));

                const alpha = Math.min(1, fg * 1.5);
                const bm = 0.6 + lum * 0.7;

                const stableRand = hashCoords(c + 1000, r + 1000);
                const sizeRatio = 0.4 + stableRand * 0.6;
                const radius = Math.max(1, ((fgPixSize - gap * 2) / 2) * sizeRatio);

                // Quantize alpha to nearest 0.2 and brightness modifier to nearest 0.1 to allow batching
                const qAlpha = Math.max(0.2, Math.round(alpha * 5) / 5);
                const qBm = Math.round(bm * 10) / 10;

                const key = `${colorIdx}_${qBm.toFixed(1)}_${qAlpha.toFixed(1)}`;
                if (!fgDrawGroups[key]) {
                    fgDrawGroups[key] = [];
                }
                fgDrawGroups[key].push({ cx, cy, radius });
            }
        }

        // Draw foreground circles grouped by color/alpha key
        for (const key in fgDrawGroups) {
            const list = fgDrawGroups[key];
            if (list.length === 0) continue;
            const parts = key.split('_');
            const colorIdx = parseInt(parts[0]);
            const qBm = parseFloat(parts[1]);
            const qAlpha = parseFloat(parts[2]);

            const [qr, qg, qb] = FG_PALETTE[colorIdx];
            const cr = Math.min(255, Math.round(qr * qBm));
            const cg = Math.min(255, Math.round(qg * qBm));
            const cb = Math.min(255, Math.round(qb * qBm));

            mosaicCtx.globalAlpha = qAlpha;
            mosaicCtx.fillStyle = `rgb(${cr},${cg},${cb})`;
            mosaicCtx.beginPath();
            for (let j = 0; j < list.length; j++) {
                const item = list[j];
                mosaicCtx.moveTo(item.cx + item.radius, item.cy);
                mosaicCtx.arc(item.cx, item.cy, item.radius, 0, Math.PI * 2);
            }
            mosaicCtx.fill();
        }
        mosaicCtx.globalAlpha = 1.0;

        mosaicAnimFrame = requestAnimationFrame(renderMosaicFrame);
    }

    async function startCamera() {
        try {
            let stream = null;
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                const legacyGetUserMedia = navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia;
                if (!legacyGetUserMedia) {
                    throw new Error("MEDIA_DEVICES_UNSUPPORTED");
                }
                stream = await new Promise((resolve, reject) => {
                    legacyGetUserMedia.call(navigator, { video: true, audio: false }, resolve, reject);
                });
            } else {
                try {
                    stream = await navigator.mediaDevices.getUserMedia({
                        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
                        audio: false
                    });
                } catch (resErr) {
                    console.warn('High-res camera failed, fallback to basic video:', resErr);
                    stream = await navigator.mediaDevices.getUserMedia({
                        video: true,
                        audio: false
                    });
                }
            }

            cameraVideo.srcObject = stream;
            await cameraVideo.play().catch(e => console.warn('Camera play warning:', e));
            cameraActive = true;

            if (cameraPermOverlay) {
                cameraPermOverlay.style.opacity = '0';
                setTimeout(() => { cameraPermOverlay.style.display = 'none'; }, 400);
            }
            if (mosaicControlBadge) {
                mosaicControlBadge.style.opacity = '1';
                mosaicControlBadge.style.pointerEvents = 'auto';
            }
            if (mosaicSpeedIndicator) mosaicSpeedIndicator.classList.add('visible');

            // Show foreground zone hint briefly
            const hint = document.getElementById('fg-zone-hint');
            if (hint) {
                hint.classList.add('visible');
                setTimeout(() => hint.classList.remove('visible'), 4000);
            }

            // Show Ishihara legend
            const legend = document.getElementById('ishihara-legend');
            if (legend) legend.classList.add('visible');

            renderMosaicFrame();
        } catch (err) {
            console.warn('Camera denied or unavailable:', err);
            if (cameraPermOverlay) {
                const p = cameraPermOverlay.querySelector('.camera-permission-box p');
                if (p) {
                    if (window.location.protocol === 'file:') {
                        p.innerHTML = '로컬 파일(file://)에서는 카메라가 차단됩니다.<br><code>node server.js</code> 실행 후 <a href="http://localhost:3000/산학%207번%20SNS/index.html" style="color:#0095f6;">http://localhost:3000</a> 으로 접속해주세요.';
                    } else if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                        p.textContent = '카메라 접근이 거부되었습니다. 크롬 주소창 좌측 🔒 아이콘에서 카메라를 허용해 주세요.';
                    } else if (err.name === 'NotFoundError') {
                        p.textContent = '사용 가능한 카메라 장치를 찾을 수 없습니다.';
                    } else if (err.name === 'NotReadableError') {
                        p.textContent = '다른 프로그램에서 카메라를 사용 중입니다. 카메라 사용을 종료하고 다시 시도하세요.';
                    } else {
                        p.textContent = `카메라를 시작할 수 없습니다: ${err.message || err.name}`;
                    }
                }
            }
        }
    }

    let manualOverrideTimeout = null;
    const handleSliderInput = e => {
        state.manualOverride = true;
        const val = parseInt(e.target.value);
        mosaicPixelSize = val;
        if (mosaicValDisplay) mosaicValDisplay.textContent = `${val}px`;
        if (mosaicSpeedPx)    mosaicSpeedPx.textContent = `${val}px`;
        console.log(`Manual override active: mosaic pixel size set to ${val}px`);

        clearTimeout(manualOverrideTimeout);
        manualOverrideTimeout = setTimeout(() => {
            state.manualOverride = false;
            console.log('Manual override inactive: resuming auto speed scaling');
        }, 4000); // Resume auto scaling after 4 seconds of slider inactivity
    };
    mosaicSlider?.addEventListener('input', handleSliderInput);
    mosaicSlider?.addEventListener('change', handleSliderInput);
    btnRequestCamera?.addEventListener('click', startCamera);
    startCamera();

    // =========================================================================
    // DYNAMIC ISLAND
    // =========================================================================
    islandTrigger?.addEventListener('click', () => {
        if (simIsland?.classList.contains('minimized')) {
            simIsland.classList.remove('minimized');
            simIsland.classList.add('expanded');
        }
    });
    btnIslandMinimize?.addEventListener('click', e => {
        e.stopPropagation();
        if (simIsland?.classList.contains('expanded')) {
            simIsland.classList.remove('expanded');
            simIsland.classList.add('minimized');
        }
    });

    // =========================================================================
    // SPEED-LINE PARTICLES
    // =========================================================================
    const particles = [];
    const maxParticles = 35;

    class Particle {
        constructor() { this.reset(true); }
        reset(anywhere = false) {
            this.x = anywhere
                ? Math.random() * (particleCanvas?.width || 500)
                : (particleCanvas?.width || 500) + Math.random() * 50;
            this.y = Math.random() * (particleCanvas?.height || 400);
            this.length = 40 + Math.random() * 60;
            this.speedFactor = 0.9 + Math.random() * 1.5;
            this.opacity = 0.15 + Math.random() * 0.45;
            this.width = 1.2 + Math.random() * 1.8;
            this.color = Math.random() > 0.5 ? '255,255,255' : '0,113,227';
        }
        update(speedVal, on) {
            if (!on || speedVal <= 0) {
                this.opacity -= 0.015;
                if (this.opacity <= 0) { this.reset(); this.opacity = 0; }
            } else {
                this.x -= (speedVal * 0.5 + 4) * this.speedFactor;
                if (this.opacity < 0.6) this.opacity += 0.03;
            }
            if (this.x < -this.length) this.reset(false);
        }
        draw() {
            if (!pCtx || this.opacity <= 0) return;
            pCtx.beginPath();
            const g = pCtx.createLinearGradient(this.x, this.y, this.x + this.length, this.y);
            g.addColorStop(0, `rgba(${this.color},${this.opacity})`);
            g.addColorStop(1, `rgba(${this.color},0)`);
            pCtx.strokeStyle = g;
            pCtx.lineWidth = this.width;
            pCtx.moveTo(this.x, this.y);
            pCtx.lineTo(this.x + this.length, this.y);
            pCtx.stroke();
        }
    }
    for (let i = 0; i < maxParticles; i++) particles.push(new Particle());

    // =========================================================================
    // LIKE BURST ANIMATION
    // =========================================================================
    const heartBurstContainer = document.getElementById('heart-burst-container');
    function spawnFloatingHeart() {
        if (!heartBurstContainer) return;
        const heart = document.createElement('div');
        heart.className = 'floating-heart';

        // Create Instagram red/pink heart SVG
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('width', '100%');
        svg.setAttribute('height', '100%');

        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z');
        path.setAttribute('fill', '#ff3040');
        svg.appendChild(path);

        heart.appendChild(svg);

        // Randomize initial horizontal position within container (wide dispersion)
        const leftOffset = Math.random() * 120 - 60; // -60px to +60px from center
        heart.style.left = `calc(50% + ${leftOffset}px)`;

        // Randomize size of the badge (width/height from 20px to 36px)
        const size = 20 + Math.random() * 16;
        heart.style.width = `${size}px`;
        heart.style.height = `${size}px`;

        // Randomize scales for 3D depth variety
        const scale0 = 0.5 + Math.random() * 0.3;
        const scale1 = 1.0 + Math.random() * 0.4;

        // Randomize sway values using css variables (wide horizontal sways)
        const sway1 = Math.random() * 60 - 30;   // -30px to 30px
        const sway2 = Math.random() * 100 - 50;  // -50px to 50px
        const sway3 = Math.random() * 140 - 70;  // -70px to 70px

        const rot1 = Math.random() * 60 - 30;   // -30deg to 30deg
        const rot2 = Math.random() * 120 - 60;  // -60deg to 60deg
        const rot3 = Math.random() * 180 - 90;  // -90deg to 90deg

        const duration = 2.0 + Math.random() * 1.5; // 2s to 3.5s

        heart.style.setProperty('--scale-0', scale0.toString());
        heart.style.setProperty('--scale-1', scale1.toString());
        heart.style.setProperty('--sway-1', `${sway1}px`);
        heart.style.setProperty('--sway-2', `${sway2}px`);
        heart.style.setProperty('--sway-3', `${sway3}px`);
        heart.style.setProperty('--rot-1', `${rot1}deg`);
        heart.style.setProperty('--rot-2', `${rot2}deg`);
        heart.style.setProperty('--rot-3', `${rot3}deg`);
        heart.style.animationDuration = `${duration}s`;

        heartBurstContainer.appendChild(heart);

        // Remove from DOM when animation ends
        setTimeout(() => {
            heart.remove();
        }, duration * 1000);
    }

    // =========================================================================
    // REACTION COUNTER ANIMATION (ride duration driven)
    // =========================================================================
    function formatNum(n) {
        if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
        return String(Math.floor(n));
    }

    let lastPopTime = 0;
    function updateReactionCounts() {
        if (!state.isOperating || !state.rideStartTime) return;
        const elapsed = state.rideDurationSec;

        // Counts grow proportional to ride time
        const likes    = state.baseLikes    + Math.floor(elapsed * 2.5);
        const comments = state.baseComments + Math.floor(elapsed * 0.4);
        const shares   = state.baseShares   + Math.floor(elapsed * 0.1);

        if (likeCountNum)    likeCountNum.textContent    = formatNum(likes);
        if (commentCountNum) commentCountNum.textContent = formatNum(comments);
        if (shareCountNum)   shareCountNum.textContent   = formatNum(shares);

        // Pop animation every ~2 seconds (visible count-increment hint)
        const now = Date.now();
        if (now - lastPopTime > 2000 && state.speed >= LIVE_SPEED_THRESHOLD) {
            lastPopTime = now;
            [likeCountNum, commentCountNum, shareCountNum].forEach(el => {
                if (!el) return;
                el.classList.remove('count-popping');
                void el.offsetWidth; // force reflow
                el.classList.add('count-popping');
                setTimeout(() => el.classList.remove('count-popping'), 280);
            });
        }
    }

    // =========================================================================
    // AUTO-COMPLETED RIDE CARD
    // =========================================================================
    const ROUTE_NAMES = [
        'Mapo River Cruise', 'Yeouido Night Ride', 'Banpo Bridge Loop',
        'Olympic Park Sprint', 'Ttukseom Riverside', 'Hongdae Night Tour',
    ];

    function showCompletedCard() {
        if (!completedCard || state.completedCardShown) return;
        state.completedCardShown = true;

        const distKm = state.totalDistanceKm.toFixed(1);
        const avgSpeed = state.speedSamples.length
            ? Math.round(state.speedSamples.reduce((a,b)=>a+b,0) / state.speedSamples.length)
            : 0;
        const zone = LOCATION_ZONES[currentZoneIndex];
        const routeName = ROUTE_NAMES[currentZoneIndex % ROUTE_NAMES.length];
        const durationMin = Math.floor(state.rideDurationSec / 60);

        if (completedLocName)  completedLocName.textContent  = zone.name;
        if (completedRouteName) completedRouteName.textContent = routeName;
        if (completedStats)    completedStats.innerHTML      =
            `🛣 ${distKm} km Completed &nbsp;·&nbsp; ⚡ Avg ${avgSpeed} km/h`;
        if (completedCaption)  completedCaption.textContent  =
            `${durationMin}분간의 라이딩 완료! ${distKm}km를 달렸어요. 시스템이 자동으로 기록했습니다 🛴✨`;
        if (completedTimestamp) completedTimestamp.textContent = 'Just now · 🌍';

        // Reveal with slide-in animation
        completedCard.style.display = 'flex';
        completedCard.style.flexDirection = 'column';
        completedCard.style.opacity = '0';
        completedCard.style.transform = 'translateY(20px)';
        completedCard.style.transition = 'opacity 0.6s ease, transform 0.6s ease';
        setTimeout(() => {
            completedCard.style.opacity = '1';
            completedCard.style.transform = 'translateY(0)';
        }, 50);
    }

    // =========================================================================
    // LIVE / OFFLINE AUTO TOGGLE
    // =========================================================================
    const LIVE_SPEED_THRESHOLD = 5; // km/h — above this = LIVE

    function checkLiveToggle() {
        const postRideBadge = document.getElementById('post-ride-badge');
        const isLive = state.isOperating && state.speed >= LIVE_SPEED_THRESHOLD;

        if (isLive && !state.wasLive) {
            // Transition to LIVE
            state.wasLive = true;
            state.rideStartTime = Date.now();
            state.completedCardShown = false;
        } else if (!isLive && state.wasLive && state.speed === 0 && state.isOperating) {
            // Ride stopped: auto-generate completed card
            state.wasLive = false;
            showCompletedCard();
        }

        if (postRideBadge) {
            if (isLive) {
                postRideBadge.textContent = '● LIVE';
                postRideBadge.className = 'fb-live-badge';
            } else if (state.isOperating && state.speed > 0) {
                postRideBadge.textContent = 'STARTING';
                postRideBadge.className = 'fb-live-badge';
                postRideBadge.style.background = '#ff9500';
            } else {
                postRideBadge.textContent = 'OFFLINE';
                postRideBadge.className = 'fb-completed-badge';
                postRideBadge.style.background = '';
            }
        }
    }

    // =========================================================================
    // MAIN ANIMATION LOOP
    // =========================================================================
    function loop(timestamp) {
        const dt = Math.min((timestamp - state.lastTime) / 1000, 0.1); // cap at 100ms
        state.lastTime = timestamp;
 
        // Check telemetry timeout
        if (isUsingSharedTelemetry && Date.now() - lastTelemetryReceivedTime > 2000) {
            isUsingSharedTelemetry = false;
        }

        // Auto-simulate active riding state only when explicitly operating
        if (state.isOperating) {
            if (!state.simManualOverride && !isUsingSharedTelemetry) {
                state.speed = 24.5 + Math.sin(Date.now() / 6000) * 8.5;
                state.rotation = Math.sin(Date.now() / 3200) * 35;
            }
        } else {
            if (!isUsingSharedTelemetry && !state.simManualOverride) {
                state.speed = 0;
                state.rotation = 0;
            }
        }
 
        // --- 1. SPEED: Accumulate ride telemetry ---
        if (state.isOperating && state.speed > 0) {
            state.rideDurationSec += dt;
            const now = Date.now();
            if (now - state.lastSampleTime >= 1000) {
                state.speedSamples.push(state.speed);
                state.lastSampleTime = now;
                // Cap samples array to avoid memory growth (3600 samples = 1 hour)
                if (state.speedSamples.length > 3600) state.speedSamples.shift();
            }
        }
 
        // --- 2. STEER: Palette hue shift ---
        // rotation -90..90 → hue target -20..+20 degrees
        const targetHue = state.rotation * (20 / 90);
        state.paletteHueShift += (targetHue - state.paletteHueShift) * 0.08;
 
        // --- 3. GPS integration ---
        updateGPS(dt);
 
        // --- 4. Particle speed lines (removed as requested) ---
        if (pCtx && particleCanvas) {
            pCtx.clearRect(0, 0, particleCanvas.width, particleCanvas.height);
        }
 
        // --- 5. Mosaic pixel size (Fixed to smallest circular size 6px) ---
        mosaicPixelSize = 6;
 
        // --- 6. Steer glow indicators ---
        if (leftGlow && rightGlow) {
            const abs = Math.abs(state.rotation);
            if (state.rotation < -12) {
                leftGlow.style.opacity  = Math.min(0.8, (abs - 12) / 45).toString();
                rightGlow.style.opacity = '0';
            } else if (state.rotation > 12) {
                rightGlow.style.opacity = Math.min(0.8, (abs - 12) / 45).toString();
                leftGlow.style.opacity  = '0';
            } else {
                leftGlow.style.opacity = rightGlow.style.opacity = '0';
            }
        }
 
        // --- 7. SPEED + STEER → Feed scroll (disabled as requested) ---
        // Speed adds base forward scroll, steer adds directional component
        /*
        if (feedMainLayout) {
            let targetScroll = 0;
            if (state.isOperating && state.speed > 0) {
                // Speed contributes a gentle forward drift
                targetScroll += state.speed * 0.25;
            }
            if (Math.abs(state.rotation) > 3) {
                // Steer adds directional scroll (positive = down, negative = up)
                targetScroll += state.rotation * 6.5;
            }
            state.currentScrollSpeed += (targetScroll - state.currentScrollSpeed) * 0.12;
            if (Math.abs(state.currentScrollSpeed) > 0.15) {
                feedMainLayout.scrollTop += state.currentScrollSpeed * dt;
            }
        }
        */
 
        // --- 8. LIVE toggle check ---
        checkLiveToggle();
 
        // --- 9. Reaction count animation (ride duration) ---
        updateReactionCounts();

        // --- 10. Real-time Heart/Like Burst ---
        if (state.isOperating && state.speed > 0) {
            state.heartAccumulator += dt;
            const spawnInterval = 1 / (state.speed * 0.15 + 0.1);
            if (state.heartAccumulator >= spawnInterval) {
                spawnFloatingHeart();
                state.heartAccumulator = 0;
            }
        }

        // --- 11. Real-time UI Update ---
        updateUI();
 
        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);

    // =========================================================================
    // UI UPDATERS
    // =========================================================================
    function updateUI() {
        const speedVal = state.speed;
        const rotVal = state.rotation;

        const speedRound = speedVal.toFixed(1);
        const rotRound = Math.round(rotVal);

        // Update range inputs only when active simulation override is off (avoid fighting with user drag)
        if (simInputSpeed && !state.simManualOverride) {
            const valStr = String(Math.round(speedVal));
            if (simInputSpeed.value !== valStr) simInputSpeed.value = valStr;
        }
        if (simInputRotation && !state.simManualOverride) {
            const valStr = String(rotRound);
            if (simInputRotation.value !== valStr) simInputRotation.value = valStr;
        }

        const speedText = `${speedRound} km/h`;
        const rotText = `${rotRound}°`;

        if (simValSpeed && simValSpeed.textContent !== speedText) {
            simValSpeed.textContent = speedText;
        }
        if (simValRotation && simValRotation.textContent !== rotText) {
            simValRotation.textContent = rotText;
        }

        if (islandStatSpeed && islandStatSpeed.textContent !== speedText) {
            islandStatSpeed.textContent = speedText;
        }
        if (islandStatRot && islandStatRot.textContent !== rotText) {
            islandStatRot.textContent = rotText;
        }

        if (overlaySpeed && overlaySpeed.textContent !== speedText) {
            overlaySpeed.textContent = speedText;
        }
        if (overlayRotation && overlayRotation.textContent !== rotText) {
            overlayRotation.textContent = rotText;
        }

        if (overlayStatusIndicator) {
            let statusText = 'OFFLINE';
            let statusClass = 'hud-item status-indicator';
            if (state.isOperating) {
                const isLive = speedVal >= LIVE_SPEED_THRESHOLD;
                statusText = isLive ? 'LIVE' : (speedVal > 0 ? 'STARTING' : 'STATIONARY');
                statusClass = 'hud-item status-indicator' + (speedVal > 0 ? ' active' : '');
            }
            if (overlayStatusIndicator.textContent !== statusText) {
                overlayStatusIndicator.textContent = statusText;
            }
            if (overlayStatusIndicator.className !== statusClass) {
                overlayStatusIndicator.className = statusClass;
            }
        }


    }

    // =========================================================================
    // POWER STATE
    // =========================================================================
    function setPowerState(on) {
        state.isOperating = on;
        if (!on) {
            state.speed = 0;
            state.rotation = 0;
            // If we were live, trigger completed card
            if (state.wasLive) {
                state.wasLive = false;
                showCompletedCard();
            }
            // Reset GPS state for new session
            state.totalDistanceKm = 0;
            state.speedSamples    = [];
            state.rideDurationSec = 0;
            state.rideStartTime   = null;
            currentZoneIndex = 0;
            if (postLocationTag) postLocationTag.style.display = 'none';
        }
        simBtnPower?.classList[on ? 'add' : 'remove']('active');
        if (simBtnPower) simBtnPower.textContent = on ? 'STOP' : 'START';
        updateUI();
    }

    // =========================================================================
    // EVENT BINDINGS
    // =========================================================================
    let simOverrideTimeout = null;
    function triggerSimManualOverride() {
        state.simManualOverride = true;
        clearTimeout(simOverrideTimeout);
        simOverrideTimeout = setTimeout(() => {
            state.simManualOverride = false;
        }, 8000); // Resume auto simulation after 8 seconds of inactivity
    }

    simBtnPower?.addEventListener('click', () => {
        setPowerState(!state.isOperating);
        if (state.isOperating) {
            state.simManualOverride = false; // Reset override on power on
        }
    });

    simInputSpeed?.addEventListener('input', e => {
        const val = parseInt(e.target.value);
        if (val > 0 && !state.isOperating) setPowerState(true);
        state.speed = val;
        triggerSimManualOverride();
        updateUI();
    });

    simInputRotation?.addEventListener('input', e => {
        state.rotation = parseInt(e.target.value);
        triggerSimManualOverride();
        updateUI();
    });

    // Preset: City Cruise
    simPresetCruise?.addEventListener('click', () => {
        if (!state.isOperating) setPowerState(true);
        state.speed    = 25;
        state.rotation = 0;
        triggerSimManualOverride();
        updateUI();
    });

    // Preset: Steer Curve
    simPresetCurve?.addEventListener('click', () => {
        if (!state.isOperating) setPowerState(true);
        state.speed    = 35;
        state.rotation = 40;
        triggerSimManualOverride();
        updateUI();
    });

    // Preset: Stop → triggers completed card if was LIVE
    simPresetStop?.addEventListener('click', () => {
        if (state.wasLive) {
            state.wasLive = false;
            showCompletedCard();
        }
        state.speed    = 0;
        state.rotation = 0;
        triggerSimManualOverride();
        updateUI();
    });

    // Toggle Like button active state
    btnLikePost?.addEventListener('click', (e) => {
        e.preventDefault();
        btnLikePost.classList.toggle('active');
    });

    // =========================================================================
    // SHARED CAMERA RECEIVER LOGIC
    // =========================================================================
    // =========================================================================
    // SHARED CAMERA RECEIVER & TOUCHDESIGNER WEBSOCKET CLIENT
    // =========================================================================
    function setSharedImageSource(imageSource) {
        lastFrameReceivedTime = Date.now();
        
        let promise;
        if (imageSource instanceof Blob) {
            promise = createImageBitmap(imageSource);
        } else if (typeof imageSource === 'string') {
            const img = new Image();
            img.src = imageSource;
            promise = img.decode().then(() => createImageBitmap(img));
        } else if (imageSource instanceof ImageBitmap) {
            promise = Promise.resolve(imageSource);
        } else {
            return;
        }

        promise.then(bitmap => {
            if (sharedFrameImage && sharedFrameImage.close) {
                sharedFrameImage.close();
            }
            sharedFrameImage = bitmap;
            
            if (!isUsingSharedCamera) {
                isUsingSharedCamera = true;
                if (cameraPermOverlay) {
                    cameraPermOverlay.style.opacity = '0';
                    setTimeout(() => { cameraPermOverlay.style.display = 'none'; }, 400);
                }
                if (mosaicControlBadge) {
                    mosaicControlBadge.style.opacity = '1';
                    mosaicControlBadge.style.pointerEvents = 'auto';
                }
                if (mosaicSpeedIndicator) mosaicSpeedIndicator.classList.add('visible');
                const legend = document.getElementById('ishihara-legend');
                if (legend) legend.classList.add('visible');
                
                if (!mosaicAnimFrame) {
                    renderMosaicFrame();
                }
            }
        }).catch(err => {
            console.error("Error creating ImageBitmap:", err);
        });
    }

    function handleSharedData(data) {
        if (!data) return;

        if (data instanceof Blob || data instanceof ArrayBuffer) {
            const blob = data instanceof Blob ? data : new Blob([data], { type: 'image/jpeg' });
            setSharedImageSource(blob);
            return;
        }

        if (data.type === 'frame') {
            const imgSrc = data.blob || data.image || data.data;
            if (imgSrc) setSharedImageSource(imgSrc);
        } else if (data.type === 'telemetry') {
            lastTelemetryReceivedTime = Date.now();
            isUsingSharedTelemetry = true;
            if (data.speed !== undefined) state.speed = Number(data.speed);
            if (data.rotation !== undefined) state.rotation = Number(data.rotation);
            state.isOperating = data.cameraActive || state.speed > 0;
            updateUI();
        }
    }

    // Global WebSocket connection tracker for local camera broadcasting
    let activeWsSocket = null;
    const localStreamCanvas = document.createElement('canvas');
    const localStreamCtx = localStreamCanvas.getContext('2d');

    function broadcastLocalCameraFrame() {
        if (!cameraActive || isUsingSharedCamera || !activeWsSocket || activeWsSocket.readyState !== WebSocket.OPEN) {
            return;
        }
        if (!cameraVideo || cameraVideo.readyState < 2) return;

        const W = cameraVideo.videoWidth || 640;
        const H = cameraVideo.videoHeight || 480;
        localStreamCanvas.width = W;
        localStreamCanvas.height = H;
        localStreamCtx.drawImage(cameraVideo, 0, 0, W, H);

        localStreamCanvas.toBlob((blob) => {
            if (blob && activeWsSocket && activeWsSocket.readyState === WebSocket.OPEN) {
                activeWsSocket.send(blob);
            }
        }, 'image/jpeg', 0.75);
    }

    setInterval(broadcastLocalCameraFrame, 50);

    // Register WebSocket Connection to Server
    function initWebSocketConnection() {
        let wsUrl;
        if (window.location.protocol === 'file:') {
            wsUrl = 'ws://localhost:3000';
        } else {
            const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            wsUrl = `${wsProtocol}//${window.location.host}`;
        }

        try {
            const socket = new WebSocket(wsUrl);
            socket.binaryType = 'blob';

            socket.onopen = () => {
                console.log(`[WS Client] Connected to server at ${wsUrl}`);
                activeWsSocket = socket;
            };

            socket.onmessage = (event) => {
                if (event.data instanceof Blob || event.data instanceof ArrayBuffer) {
                    handleSharedData(event.data);
                } else if (typeof event.data === 'string') {
                    try {
                        const data = JSON.parse(event.data);
                        handleSharedData(data);
                    } catch (e) {
                        if (event.data.startsWith('data:image/') || event.data.length > 500) {
                            handleSharedData({ type: 'frame', image: event.data });
                        }
                    }
                }
            };

            socket.onclose = () => {
                activeWsSocket = null;
                console.warn('[WS Client] Disconnected from server. Reconnecting in 2s...');
                setTimeout(initWebSocketConnection, 2000);
            };

            socket.onerror = (err) => {
                activeWsSocket = null;
                console.error('[WS Client Error]', err);
                socket.close();
            };
        } catch (err) {
            console.error('[WS Client Init Error]', err);
            setTimeout(initWebSocketConnection, 3000);
        }
    }

    initWebSocketConnection();

    // Register BroadcastChannel listener
    if (typeof BroadcastChannel !== 'undefined') {
        const cameraChannel = new BroadcastChannel('camera-shared-stream');
        cameraChannel.onmessage = (event) => {
            handleSharedData(event.data);
        };
    }

    // Register postMessage listener
    window.addEventListener('message', (event) => {
        handleSharedData(event.data);
    });

    // Check shared stream timeout (heartbeat)
    setInterval(() => {
        if (isUsingSharedCamera && Date.now() - lastFrameReceivedTime > 2000) {
            isUsingSharedCamera = false;
            if (sharedFrameImage && sharedFrameImage.close) {
                sharedFrameImage.close();
            }
            sharedFrameImage = null;
            
            // Restore permission overlay if local camera is off
            if (!cameraActive && cameraPermOverlay) {
                cameraPermOverlay.style.display = 'flex';
                cameraPermOverlay.style.opacity = '1';
            }
            if (mosaicSpeedIndicator) mosaicSpeedIndicator.classList.remove('visible');
            if (mosaicControlBadge) {
                mosaicControlBadge.style.opacity = '0';
                mosaicControlBadge.style.pointerEvents = 'none';
            }
            const legend = document.getElementById('ishihara-legend');
            if (legend) legend.classList.remove('visible');
        }
    }, 1000);

    // =========================================================================
    // SUPABASE INTEGRATION
    // =========================================================================
    const SUPABASE_URL = 'https://ebbkanusdggvhgbjxteb.supabase.co';
    const SUPABASE_ANON_KEY = 'sb_publishable_NOp-io1PGhFeHsHC11FOgg_QPRfAPrS';
    let supabaseClient = null;

    if (window.supabase) {
        try {
            supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
            console.log('[Supabase Client] Initialized with URL:', SUPABASE_URL);
            window.supabaseClient = supabaseClient;
        } catch (err) {
            console.warn('[Supabase Client Init Error]:', err);
        }
    }

    window.state = state;
    updateUI();
});
