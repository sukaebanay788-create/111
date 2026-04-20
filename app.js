// Binance Futures Screener (с 10м/30м изменениями, без фильтров)
const BINANCE_WS = 'wss://fstream.binance.com/ws';
const BINANCE_API = 'https://fapi.binance.com';

let coins = new Map();
let filteredCoins = [];   // теперь всегда равен всем монетам
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

// Для истории
let currentCandles = [];
let oldestTime = null;
let isLoadingMore = false;

// Инициализация
async function init() {
    await loadCoins();
    initChart();
    connectWebSocket();
    setupFilters();   // на самом деле теперь только настройка событий
    loadChartData(currentSymbol);
}

// Загрузка списка фьючерсов с расчётом 10м/30м изменений
async function loadCoins() {
    try {
        const exchangeInfoRes = await fetch(`${BINANCE_API}/fapi/v1/exchangeInfo`);
        const exchangeData = await exchangeInfoRes.json();
        
        const usdtPairs = exchangeData.symbols.filter(s => 
            s.quoteAsset === 'USDT' && 
            s.status === 'TRADING' &&
            s.contractType === 'PERPETUAL'
        );

        // Получаем 24h изменения
        const tickersRes = await fetch(`${BINANCE_API}/fapi/v1/ticker/24hr`);
        const tickers = await tickersRes.json();
        const tickersMap = new Map(tickers.map(t => [t.symbol, t]));

        // Для каждой пары получаем 10м и 30м свечи
        const promises = usdtPairs.map(async (pair) => {
            const symbol = pair.symbol;
            const ticker = tickersMap.get(symbol);
            if (!ticker) return null;

            try {
                // Получаем последние 2 свечи 10m и 30m (достаточно одной, но берём две для расчёта изменения)
                const [klines10m, klines30m] = await Promise.all([
                    fetch(`${BINANCE_API}/fapi/v1/klines?symbol=${symbol}&interval=10m&limit=2`).then(r => r.json()),
                    fetch(`${BINANCE_API}/fapi/v1/klines?symbol=${symbol}&interval=30m&limit=2`).then(r => r.json())
                ]);

                let change10m = 0;
                let change30m = 0;

                // Расчёт 10м изменения: (close последней свечи - open последней свечи) / open * 100
                if (klines10m.length >= 1) {
                    const lastCandle = klines10m[klines10m.length - 1];
                    const open = parseFloat(lastCandle[1]);
                    const close = parseFloat(lastCandle[4]);
                    change10m = ((close - open) / open) * 100;
                }

                // Аналогично для 30м
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
                    change10m,
                    change30m,
                    volume: parseFloat(ticker.volume),
                    high: parseFloat(ticker.highPrice),
                    low: parseFloat(ticker.lowPrice)
                };
            } catch (e) {
                console.error(`Ошибка загрузки данных для ${symbol}:`, e);
                // Если не удалось получить 10m/30m, оставляем нули
                return {
                    symbol,
                    price: parseFloat(ticker.lastPrice),
                    change: parseFloat(ticker.priceChangePercent),
                    change10m: 0,
                    change30m: 0,
                    volume: parseFloat(ticker.volume),
                    high: parseFloat(ticker.highPrice),
                    low: parseFloat(ticker.lowPrice)
                };
            }
        });

        const results = await Promise.all(promises);
        
        results.forEach(coinData => {
            if (coinData) {
                coins.set(coinData.symbol, coinData);
            }
        });

        // Фильтрации больше нет, просто копируем все монеты в filteredCoins
        filteredCoins = Array.from(coins.values());
        sortCoins();
        renderCoinsList();
        updateCoinsCount();
        
    } catch (error) {
        console.error('Ошибка загрузки монет:', error);
        document.getElementById('coinsList').innerHTML = 
            '<div class="loading">Ошибка загрузки</div>';
    }
}

// График
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

    // EMA 65 (светло-серый, без маркеров)
    ema65Series = chart.addLineSeries({
        color: '#a0a4ab',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        autoscaleInfoProvider: () => null,
    });

    // EMA 125 (светло-серый, без маркеров)
    ema125Series = chart.addLineSeries({
        color: '#a0a4ab',
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        autoscaleInfoProvider: () => null,
    });

    // EMA 450 (почти белый, толще, без маркеров)
    ema450Series = chart.addLineSeries({
        color: '#e0e3e8',
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        autoscaleInfoProvider: () => null,
    });

    window.addEventListener('resize', () => {
        chart.applyOptions({ width: container.clientWidth, height: container.clientHeight });
    });
}

// Расчёт EMA
function calculateEMA(data, period) {
    if (data.length < period) return [];
    
    const ema = [];
    const multiplier = 2 / (period + 1);
    
    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += data[i].close;
    }
    let prevEma = sum / period;
    ema.push({ time: data[period - 1].time, value: prevEma });
    
    for (let i = period; i < data.length; i++) {
        const currentPrice = data[i].close;
        prevEma = (currentPrice - prevEma) * multiplier + prevEma;
        ema.push({ time: data[i].time, value: prevEma });
    }
    
    return ema;
}

// Первичная загрузка свечей (1400)
async function loadChartData(symbol) {
    try {
        const res = await fetch(
            `${BINANCE_API}/fapi/v1/klines?symbol=${symbol}&interval=${currentTimeframe}&limit=1400`
        );
        const klines = await res.json();
        
        currentCandles = klines.map(k => ({
            time: k[0] / 1000,
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
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
    
    const ema65 = calculateEMA(candles, 65);
    const ema125 = calculateEMA(candles, 125);
    const ema450 = calculateEMA(candles, 450);
    
    ema65Series.setData(ema65);
    ema125Series.setData(ema125);
    ema450Series.setData(ema450);
}

// Подгрузка более старых свечей
async function loadMoreHistory() {
    if (isLoadingMore || !oldestTime) return;
    isLoadingMore = true;
    
    const btn = document.getElementById('loadMoreBtn');
    btn.textContent = '⏳';
    btn.disabled = true;
    
    try {
        const endTime = oldestTime - 1;
        const res = await fetch(
            `${BINANCE_API}/fapi/v1/klines?symbol=${currentSymbol}&interval=${currentTimeframe}&limit=1000&endTime=${endTime}`
        );
        const klines = await res.json();
        
        if (klines.length === 0) {
            console.log('Больше истории нет');
            btn.textContent = '📜';
            btn.disabled = false;
            isLoadingMore = false;
            return;
        }
        
        const newCandles = klines.map(k => ({
            time: k[0] / 1000,
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
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

// WebSocket
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
    
    ws.onerror = (e) => {
        console.error('WS error:', e);
        updateConnectionStatus(false);
    };
}

function updateSubscriptions() {
    if (!wsReady || ws.readyState !== WebSocket.OPEN) return;
    
    const target = new Set(filteredCoins.slice(0, 50).map(c => c.symbol.toLowerCase()));
    const toUnsub = [];
    const toSub = [];
    
    lastSubscriptionSet.forEach(sym => { if (!target.has(sym)) toUnsub.push(`${sym}@ticker`); });
    target.forEach(sym => { if (!lastSubscriptionSet.has(sym)) toSub.push(`${sym}@ticker`); });
    
    if (toUnsub.length) ws.send(JSON.stringify({ method: 'UNSUBSCRIBE', params: toUnsub, id: Date.now() }));
    if (toSub.length) ws.send(JSON.stringify({ method: 'SUBSCRIBE', params: toSub, id: Date.now()+1 }));
    
    lastSubscriptionSet = target;
}

function subscribeToKlineStream(symbol) {
    if (!wsReady || ws.readyState !== WebSocket.OPEN) return;
    
    if (currentKlineSymbol && currentKlineSymbol !== symbol) {
        ws.send(JSON.stringify({
            method: 'UNSUBSCRIBE',
            params: [`${currentKlineSymbol.toLowerCase()}@kline_${currentTimeframe}`],
            id: Date.now()
        }));
    }
    ws.send(JSON.stringify({
        method: 'SUBSCRIBE',
        params: [`${symbol.toLowerCase()}@kline_${currentTimeframe}`],
        id: Date.now()+1
    }));
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
    const candle = {
        time: k.t / 1000,
        open: parseFloat(k.o),
        high: parseFloat(k.h),
        low: parseFloat(k.l),
        close: parseFloat(k.c)
    };
    
    candleSeries.update(candle);
    
    const existingIndex = currentCandles.findIndex(c => c.time === candle.time);
    if (existingIndex !== -1) {
        currentCandles[existingIndex] = candle;
    } else {
        currentCandles.push(candle);
        currentCandles.sort((a, b) => a.time - b.time);
    }
    
    updateEmaLines(currentCandles);
}

// UI
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

// Функция setupFilters переименована, но оставлена для совместимости (настройка событий)
function setupFilters() {
    // События для кнопок таймфрейма и сортировки
    document.querySelectorAll('.tf-btn').forEach(btn => {
        btn.addEventListener('click', () => setTimeframe(btn.dataset.tf));
    });
    document.querySelectorAll('#listHeader span').forEach(span => {
        span.addEventListener('click', () => sortBy(span.dataset.sort));
    });
    document.getElementById('loadMoreBtn').addEventListener('click', loadMoreHistory);
}

// Сортировка
function sortBy(field) {
    if (sortField === field) sortDesc = !sortDesc;
    else { sortField = field; sortDesc = true; }
    sortCoins();
    renderCoinsList();
}

function sortCoins() {
    filteredCoins.sort((a, b) => {
        let va = a[sortField];
        let vb = b[sortField];
        if (typeof va === 'string') { va = va.toLowerCase(); vb = vb.toLowerCase(); }
        if (va < vb) return sortDesc ? 1 : -1;
        if (va > vb) return sortDesc ? -1 : 1;
        return 0;
    });
}

// Рендер списка (5 колонок)
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
    
    const change24hClass = coin.change >= 0 ? 'positive' : 'negative';
    const change10mClass = coin.change10m >= 0 ? 'positive' : 'negative';
    const change30mClass = coin.change30m >= 0 ? 'positive' : 'negative';
    
    const sign24h = coin.change >= 0 ? '+' : '';
    const sign10m = coin.change10m >= 0 ? '+' : '';
    const sign30m = coin.change30m >= 0 ? '+' : '';
    
    div.innerHTML = `
        <span class="coin-symbol">${coin.symbol.replace('USDT', '')}</span>
        <span class="coin-price">${formatPrice(coin.price)}</span>
        <span class="coin-change ${change24hClass}">${sign24h}${coin.change.toFixed(2)}%</span>
        <span class="coin-change ${change10mClass}">${sign10m}${coin.change10m.toFixed(2)}%</span>
        <span class="coin-change ${change30mClass}">${sign30m}${coin.change30m.toFixed(2)}%</span>
    `;
    return div;
}

function updateCoinRow(coin) {
    const row = document.querySelector(`.coin-item[data-symbol="${coin.symbol}"]`);
    if (!row) return;
    
    const change24hClass = coin.change >= 0 ? 'positive' : 'negative';
    const sign24h = coin.change >= 0 ? '+' : '';
    
    // Обновляем только цену и 24h изменение, 10m/30m не обновляются в реальном времени
    row.children[1].textContent = formatPrice(coin.price);
    row.children[2].textContent = `${sign24h}${coin.change.toFixed(2)}%`;
    row.children[2].className = `coin-change ${change24hClass}`;
    // 10m и 30m остаются без изменений
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

// Запуск
init();
