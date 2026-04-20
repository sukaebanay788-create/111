// Binance Futures Screener (без 10м, только 24ч и 30м)
const BINANCE_WS = 'wss://fstream.binance.com/ws';
const BINANCE_API = 'https://fapi.binance.com';

let coins = new Map();
let filteredCoins = [];
let currentSymbol = 'BTCUSDT';
let ws = null;
let chart = null;
let candleSeries = null;
let ema65Series = null;
let ema125Series = null;
let ema450Series = null;
let sortField = 'change';
let sortDesc = true;
let currentTimeframe = '15m';
let lastSubscriptionSet = new Set();
let currentKlineSymbol = null;
let wsReady = false;

let currentCandles = [];
let oldestTime = null;
let isLoadingMore = false;

async function init() {
    await loadCoins();
    initChart();
    connectWebSocket();
    setupEvents();
    loadChartData(currentSymbol);
}

async function loadCoins() {
    try {
        const exchangeInfoRes = await fetch(`${BINANCE_API}/fapi/v1/exchangeInfo`);
        const exchangeData = await exchangeInfoRes.json();
        
        const usdtPairs = exchangeData.symbols.filter(s => 
            s.quoteAsset === 'USDT' && 
            s.status === 'TRADING' &&
            s.contractType === 'PERPETUAL'
        );

        const tickersRes = await fetch(`${BINANCE_API}/fapi/v1/ticker/24hr`);
        const tickers = await tickersRes.json();
        const tickersMap = new Map(tickers.map(t => [t.symbol, t]));

        const promises = usdtPairs.map(async (pair) => {
            const symbol = pair.symbol;
            const ticker = tickersMap.get(symbol);
            if (!ticker) return null;

            try {
                // Только 30м свечи
                const klines30m = await fetch(`${BINANCE_API}/fapi/v1/klines?symbol=${symbol}&interval=30m&limit=2`).then(r => {
                    if (!r.ok) throw new Error('No data');
                    return r.json();
                });
                let change30m = 0;
                if (klines30m.length >= 1) {
                    const lastCandle = klines30m[klines30m.length - 1];
                    const open = parseFloat(lastCandle[1]);
                    const close = parseFloat(lastCandle[4]);
                    change30m = ((close - open) / open) * 100;
                }
                return {
                    symbol,
                    price: parseFloat(ticker.lastPrice),
                    change: parseFloat(ticker.priceChangePercent),
                    change30m,
                };
            } catch (e) {
                // Если не удалось получить 30м, оставляем 0
                return {
                    symbol,
                    price: parseFloat(ticker.lastPrice),
                    change: parseFloat(ticker.priceChangePercent),
                    change30m: 0,
                };
            }
        });

        const results = await Promise.all(promises);
        results.forEach(coinData => {
            if (coinData) coins.set(coinData.symbol, coinData);
        });

        filteredCoins = Array.from(coins.values());
        sortCoins();
        renderCoinsList();
        updateCoinsCount();
    } catch (error) {
        console.error('Ошибка загрузки монет:', error);
        document.getElementById('coinsList').innerHTML = '<div class="loading">Ошибка загрузки</div>';
    }
}

function initChart() {
    const container = document.getElementById('chart');
    chart = LightweightCharts.createChart(container, {
        layout: { background: { color: '#0b0e11' }, textColor: '#d1d4dc' },
        grid: { vertLines: { color: '#1e2329' }, horzLines: { color: '#1e2329' } },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        rightPriceScale: { borderColor: '#1e2329' },
        timeScale: { borderColor: '#1e2329', timeVisible: true },
    });

    candleSeries = chart.addCandlestickSeries({
        upColor: '#0ecb81', downColor: '#f6465d',
        borderUpColor: '#0ecb81', borderDownColor: '#f6465d',
        wickUpColor: '#0ecb81', wickDownColor: '#f6465d',
    });

    ema65Series = chart.addLineSeries({
        color: '#a0a4ab', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
        crosshairMarkerVisible: false, autoscaleInfoProvider: () => null,
    });
    ema125Series = chart.addLineSeries({
        color: '#a0a4ab', lineWidth: 1, priceLineVisible: false, lastValueVisible: false,
        crosshairMarkerVisible: false, autoscaleInfoProvider: () => null,
    });
    ema450Series = chart.addLineSeries({
        color: '#e0e3e8', lineWidth: 2, priceLineVisible: false, lastValueVisible: false,
        crosshairMarkerVisible: false, autoscaleInfoProvider: () => null,
    });

    window.addEventListener('resize', () => {
        chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
    });
}

function calculateEMA(data, period) {
    if (data.length < period) return [];
    const ema = [];
    const multiplier = 2 / (period + 1);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += data[i].close;
    let prevEma = sum / period;
    ema.push({ time: data[period - 1].time, value: prevEma });
    for (let i = period; i < data.length; i++) {
        prevEma = (data[i].close - prevEma) * multiplier + prevEma;
        ema.push({ time: data[i].time, value: prevEma });
    }
    return ema;
}

async function loadChartData(symbol) {
    try {
        const res = await fetch(`${BINANCE_API}/fapi/v1/klines?symbol=${symbol}&interval=${currentTimeframe}&limit=1400`);
        const klines = await res.json();
        currentCandles = klines.map(k => ({
            time: k[0] / 1000,
            open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]),
        }));
        oldestTime = klines.length > 0 ? klines[0][0] : null;
        candleSeries.setData(currentCandles);
        updateEmaLines(currentCandles);
        chart.timeScale().fitContent();
        if (wsReady) subscribeToKlineStream(symbol);
        updateHeader(symbol);
    } catch (e) {
        console.error('Ошибка загрузки графика:', e);
    }
}

function updateEmaLines(candles) {
    if (candles.length === 0) return;
    ema65Series.setData(calculateEMA(candles, 65));
    ema125Series.setData(calculateEMA(candles, 125));
    ema450Series.setData(calculateEMA(candles, 450));
}

async function loadMoreHistory() {
    if (isLoadingMore || !oldestTime) return;
    isLoadingMore = true;
    const btn = document.getElementById('loadMoreBtn');
    btn.textContent = '⏳';
    btn.disabled = true;
    try {
        const endTime = oldestTime - 1;
        const res = await fetch(`${BINANCE_API}/fapi/v1/klines?symbol=${currentSymbol}&interval=${currentTimeframe}&limit=1000&endTime=${endTime}`);
        const klines = await res.json();
        if (klines.length === 0) return;
        const newCandles = klines.map(k => ({
            time: k[0] / 1000,
            open: parseFloat(k[1]), high: parseFloat(k[2]), low: parseFloat(k[3]), close: parseFloat(k[4]),
        }));
        oldestTime = klines[0][0];
        currentCandles = [...newCandles, ...currentCandles];
        candleSeries.setData(currentCandles);
        updateEmaLines(currentCandles);
    } catch (e) {
        console.error('Ошибка подгрузки истории:', e);
    } finally {
        btn.textContent = '📜';
        btn.disabled = false;
        isLoadingMore = false;
    }
}

function connectWebSocket() {
    ws = new WebSocket(BINANCE_WS);
    ws.onopen = () => {
        wsReady = true;
        updateConnectionStatus(true);
        updateSubscriptions();
        if (currentSymbol) subscribeToKlineStream(currentSymbol);
    };
    ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id) return;
        if (msg.e === '24hrTicker') updateTicker(msg);
        else if (msg.e === 'kline') updateChartWithKline(msg);
    };
    ws.onclose = () => {
        wsReady = false;
        updateConnectionStatus(false);
        lastSubscriptionSet.clear();
        currentKlineSymbol = null;
        setTimeout(connectWebSocket, 5000);
    };
    ws.onerror = (e) => console.error('WS error:', e);
}

function updateSubscriptions() {
    if (!wsReady || ws.readyState !== WebSocket.OPEN) return;
    const target = new Set(filteredCoins.slice(0, 50).map(c => c.symbol.toLowerCase()));
    const toUnsub = [], toSub = [];
    lastSubscriptionSet.forEach(sym => { if (!target.has(sym)) toUnsub.push(`${sym}@ticker`); });
    target.forEach(sym => { if (!lastSubscriptionSet.has(sym)) toSub.push(`${sym}@ticker`); });
    if (toUnsub.length) ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: toUnsub, id: Date.now() }));
    if (toSub.length) ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: toSub, id: Date.now()+1 }));
    lastSubscriptionSet = target;
}

function subscribeToKlineStream(symbol) {
    if (!wsReady || ws.readyState !== WebSocket.OPEN) return;
    if (currentKlineSymbol && currentKlineSymbol !== symbol) {
        ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: [`${currentKlineSymbol.toLowerCase()}@kline_${currentTimeframe}`], id: Date.now() }));
    }
    ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: [`${symbol.toLowerCase()}@kline_${currentTimeframe}`], id: Date.now()+1 }));
    currentKlineSymbol = symbol;
}

function updateTicker(data) {
    const symbol = data.s.toUpperCase();
    const coin = coins.get(symbol);
    if (!coin) return;
    coin.price = parseFloat(data.c);
    coin.change = parseFloat(data.P);
    if (symbol === currentSymbol) updateHeader(symbol);
    const idx = filteredCoins.findIndex(c => c.symbol === symbol);
    if (idx !== -1) updateCoinRow(coin);
}

function updateChartWithKline(data) {
    const k = data.k;
    const candleTime = k.t / 1000;
    const newCandle = {
        time: candleTime,
        open: parseFloat(k.o),
        high: parseFloat(k.h),
        low: parseFloat(k.l),
        close: parseFloat(k.c)
    };
    const lastCandle = currentCandles.length > 0 ? currentCandles[currentCandles.length - 1] : null;
    if (!lastCandle) {
        currentCandles = [newCandle];
        candleSeries.setData(currentCandles);
    } else if (candleTime === lastCandle.time) {
        Object.assign(lastCandle, newCandle);
        candleSeries.update(newCandle);
    } else if (candleTime > lastCandle.time) {
        currentCandles.push(newCandle);
        candleSeries.update(newCandle);
    }
    updateEmaLines(currentCandles);
}

function updateHeader(symbol) {
    const coin = coins.get(symbol);
    if (!coin) return;
    document.getElementById('currentSymbol').textContent = symbol + ' (' + currentTimeframe + ')';
    document.getElementById('currentPrice').textContent = formatPrice(coin.price);
    const ch = document.getElementById('currentChange');
    const change = coin.change;
    ch.textContent = (change >= 0 ? '+' : '') + change.toFixed(2) + '%';
    ch.className = 'symbol-change ' + (change >= 0 ? 'positive' : 'negative');
}

function formatPrice(p) {
    if (p >= 1000) return p.toFixed(2);
    if (p >= 1) return p.toFixed(4);
    return p.toFixed(6);
}

function setupEvents() {
    document.querySelectorAll('.tf-btn').forEach(btn => {
        btn.addEventListener('click', () => setTimeframe(btn.dataset.tf));
    });
    document.querySelectorAll('#listHeader span').forEach(span => {
        span.addEventListener('click', () => sortBy(span.dataset.sort));
    });
    document.getElementById('loadMoreBtn').addEventListener('click', loadMoreHistory);
}

function sortBy(field) {
    if (sortField === field) sortDesc = !sortDesc;
    else { sortField = field; sortDesc = true; }
    sortCoins();
    renderCoinsList();
}

function sortCoins() {
    filteredCoins.sort((a, b) => {
        let va = a[sortField], vb = b[sortField];
        if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
        if (va < vb) return sortDesc ? 1 : -1;
        if (va > vb) return sortDesc ? -1 : 1;
        return 0;
    });
}

function renderCoinsList() {
    const container = document.getElementById('coinsList');
    container.innerHTML = '';
    filteredCoins.forEach(c => container.appendChild(createCoinRow(c)));
}

function createCoinRow(coin) {
    const div = document.createElement('div');
    div.className = 'coin-item' + (coin.symbol === currentSymbol ? ' active' : '');
    div.dataset.symbol = coin.symbol;
    div.onclick = () => selectCoin(coin.symbol);
    const c24 = coin.change >= 0 ? 'positive' : 'negative';
    const c30 = coin.change30m >= 0 ? 'positive' : 'negative';
    div.innerHTML = `
        <span class="coin-symbol">${coin.symbol.replace('USDT', '')}</span>
        <span class="coin-price">${formatPrice(coin.price)}</span>
        <span class="coin-change ${c24}">${coin.change >= 0 ? '+' : ''}${coin.change.toFixed(2)}%</span>
        <span class="coin-change ${c30}">${coin.change30m >= 0 ? '+' : ''}${coin.change30m.toFixed(2)}%</span>
    `;
    return div;
}

function updateCoinRow(coin) {
    const row = document.querySelector(`.coin-item[data-symbol="${coin.symbol}"]`);
    if (!row) return;
    row.children[1].textContent = formatPrice(coin.price);
    row.children[2].textContent = `${coin.change >= 0 ? '+' : ''}${coin.change.toFixed(2)}%`;
    row.children[2].className = `coin-change ${coin.change >= 0 ? 'positive' : 'negative'}`;
    // 30м не обновляется динамически
}

function selectCoin(symbol) {
    currentSymbol = symbol;
    document.querySelectorAll('.coin-item').forEach(el => {
        el.classList.toggle('active', el.dataset.symbol === symbol);
    });
    loadChartData(symbol);
    updateHeader(symbol);
}

function updateCoinsCount() {
    document.getElementById('coinsCount').textContent = filteredCoins.length;
}

function updateConnectionStatus(ok) {
    const el = document.getElementById('connStatus');
    el.textContent = ok ? 'Connected' : 'Disconnected';
    el.className = 'connection-status ' + (ok ? 'status-connected' : 'status-disconnected');
}

function setTimeframe(tf) {
    currentTimeframe = tf;
    document.querySelectorAll('.tf-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tf === tf);
    });
    document.getElementById('currentSymbol').textContent = currentSymbol + ' (' + tf + ')';
    loadChartData(currentSymbol);
}

init();
