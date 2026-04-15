// Binance Futures Screener (с динамической подпиской и real-time графиком)
const BINANCE_WS = 'wss://fstream.binance.com/ws';
const BINANCE_API = 'https://fapi.binance.com';

// Состояние
let coins = new Map();                // Все монеты
let filteredCoins = [];              // Отфильтрованные
let currentSymbol = 'BTCUSDT';
let ws = null;
let chart = null;
let candleSeries = null;
let sortField = 'change';
let sortDesc = true;
let currentTimeframe = '15m';
let lastSubscriptionSet = new Set(); // Для отслеживания подписок на цены
let currentKlineSymbol = null;       // Для отслеживания подписки на свечи

// Инициализация
async function init() {
    await loadCoins();
    initChart();
    connectWebSocket();
    setupFilters();
    loadChartData(currentSymbol);
}

// Загрузка списка фьючерсов и 24h данных
async function loadCoins() {
    try {
        // Получаем список всех фьючерсов
        const response = await fetch(`${BINANCE_API}/fapi/v1/exchangeInfo`);
        const data = await response.json();
        
        const usdtPairs = data.symbols.filter(s => 
            s.quoteAsset === 'USDT' && 
            s.status === 'TRADING' &&
            s.contractType === 'PERPETUAL'
        );

        // Загружаем 24h тикеры для изменений
        const tickersRes = await fetch(`${BINANCE_API}/fapi/v1/ticker/24hr`);
        const tickers = await tickersRes.json();
        const tickersMap = new Map(tickers.map(t => [t.symbol, t]));

        // Заполняем Map монет
        usdtPairs.forEach(pair => {
            const symbol = pair.symbol;
            const ticker = tickersMap.get(symbol);
            
            if (ticker) {
                coins.set(symbol, {
                    symbol,
                    price: parseFloat(ticker.lastPrice),
                    change: parseFloat(ticker.priceChangePercent),
                    volume: parseFloat(ticker.volume),
                    high: parseFloat(ticker.highPrice),
                    low: parseFloat(ticker.lowPrice)
                });
            }
        });

        applyFilters();
        updateCoinsCount();
        
    } catch (error) {
        console.error('Error loading coins:', error);
        document.getElementById('coinsList').innerHTML = 
            '<div class="loading">Ошибка загрузки</div>';
    }
}

// Инициализация графика
function initChart() {
    const chartContainer = document.getElementById('chart');
    
    chart = LightweightCharts.createChart(chartContainer, {
        layout: {
            background: { color: '#0b0e11' },
            textColor: '#d1d4dc',
        },
        grid: {
            vertLines: { color: '#1e2329' },
            horzLines: { color: '#1e2329' },
        },
        crosshair: {
            mode: LightweightCharts.CrosshairMode.Normal,
        },
        rightPriceScale: {
            borderColor: '#1e2329',
        },
        timeScale: {
            borderColor: '#1e2329',
            timeVisible: true,
        },
    });

    candleSeries = chart.addCandlestickSeries({
        upColor: '#0ecb81',
        downColor: '#f6465d',
        borderUpColor: '#0ecb81',
        borderDownColor: '#f6465d',
        wickUpColor: '#0ecb81',
        wickDownColor: '#f6465d',
    });

    // Ресайз
    window.addEventListener('resize', () => {
        chart.applyOptions({
            width: chartContainer.clientWidth,
            height: chartContainer.clientHeight,
        });
    });
}

// Загрузка данных для графика
async function loadChartData(symbol) {
    try {
        const response = await fetch(
            `${BINANCE_API}/fapi/v1/klines?symbol=${symbol}&interval=${currentTimeframe}&limit=200`
        );
        const klines = await response.json();
        
        const candles = klines.map(k => ({
            time: k[0] / 1000,
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
        }));

        candleSeries.setData(candles);
        chart.timeScale().fitContent();
        
        // Подписываемся на обновления свечей в реальном времени
        subscribeToKlineStream(symbol);
        updateHeader(symbol);
    } catch (error) {
        console.error('Error loading chart data:', error);
    }
}

// === WebSocket подключение ===
function connectWebSocket() {
    ws = new WebSocket(BINANCE_WS);
    
    ws.onopen = () => {
        updateConnectionStatus(true);
        // Подписываемся на первые видимые монеты
        updateSubscriptions();
    };
    
    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        
        // Обработка ответа на подписку/отписку
        if (message.id) {
            // Можно добавить логирование для отладки
            // console.log('Subscription response:', message);
            return;
        }
        
        // Обработка данных потока
        if (message.e === '24hrTicker') {
            updateTicker(message);
        } else if (message.e === 'kline') {
            updateChartWithKline(message);
        }
    };
    
    ws.onclose = () => {
        updateConnectionStatus(false);
        lastSubscriptionSet.clear();
        currentKlineSymbol = null;
        // Реконнект через 5 секунд
        setTimeout(connectWebSocket, 5000);
    };
    
    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        updateConnectionStatus(false);
    };
}

// === Динамическое управление подписками ===
function updateSubscriptions() {
    if (ws.readyState !== WebSocket.OPEN) return;

    // Определяем целевой набор символов для подписки (первые 50)
    const targetSymbols = new Set(
        filteredCoins.slice(0, 50).map(c => c.symbol.toLowerCase())
    );
    
    // Находим, от каких символов нужно отписаться
    const toUnsubscribe = [];
    lastSubscriptionSet.forEach(symbol => {
        if (!targetSymbols.has(symbol)) {
            toUnsubscribe.push(`${symbol}@ticker`);
        }
    });
    
    // Находим, на какие символы нужно подписаться
    const toSubscribe = [];
    targetSymbols.forEach(symbol => {
        if (!lastSubscriptionSet.has(symbol)) {
            toSubscribe.push(`${symbol}@ticker`);
        }
    });

    // Отправляем запросы на отписку/подписку
    if (toUnsubscribe.length > 0) {
        ws.send(JSON.stringify({
            method: "UNSUBSCRIBE",
            params: toUnsubscribe,
            id: Date.now()
        }));
    }

    if (toSubscribe.length > 0) {
        ws.send(JSON.stringify({
            method: "SUBSCRIBE",
            params: toSubscribe,
            id: Date.now() + 1
        }));
    }

    // Обновляем сохранённый набор подписок
    lastSubscriptionSet = targetSymbols;
    
    console.log(`Subscriptions updated. Active: ${targetSymbols.size}`);
}

function subscribeToKlineStream(symbol) {
    if (ws.readyState !== WebSocket.OPEN) return;
    
    // Отписываемся от предыдущего потока свечей, если он был
    if (currentKlineSymbol && currentKlineSymbol !== symbol) {
        const oldStream = `${currentKlineSymbol.toLowerCase()}@kline_${currentTimeframe}`;
        ws.send(JSON.stringify({
            method: "UNSUBSCRIBE",
            params: [oldStream],
            id: Date.now()
        }));
    }
    
    // Подписываемся на новый поток
    const newStream = `${symbol.toLowerCase()}@kline_${currentTimeframe}`;
    ws.send(JSON.stringify({
        method: "SUBSCRIBE",
        params: [newStream],
        id: Date.now() + 1
    }));
    
    currentKlineSymbol = symbol;
}

// === Обработка входящих данных WebSocket ===
function updateTicker(data) {
    const symbol = data.s.toUpperCase();
    const coin = coins.get(symbol);
    
    if (coin) {
        coin.price = parseFloat(data.c);
        coin.change = parseFloat(data.P);
        
        if (symbol === currentSymbol) {
            updateHeader(symbol);
        }
        
        // Обновляем отображение, если монета в отфильтрованном списке
        const index = filteredCoins.findIndex(c => c.symbol === symbol);
        if (index !== -1) {
            updateCoinRow(coin);
        }
    }
}

function updateChartWithKline(data) {
    const kline = data.k;
    const isCandleClosed = kline.x; // true, если свеча закрыта
    
    const candleData = {
        time: kline.t / 1000,
        open: parseFloat(kline.o),
        high: parseFloat(kline.h),
        low: parseFloat(kline.l),
        close: parseFloat(kline.c)
    };

    if (isCandleClosed) {
        // Закрытая свеча — добавляем как новую
        candleSeries.update(candleData);
    } else {
        // Текущая (незакрытая) свеча — обновляем существующую
        candleSeries.update(candleData);
    }
}

// === Обновление UI ===
function updateHeader(symbol) {
    const coin = coins.get(symbol);
    if (!coin) return;
    
    document.getElementById('currentSymbol').textContent = symbol + ' (' + currentTimeframe + ')';
    document.getElementById('currentPrice').textContent = formatPrice(coin.price);
    
    const changeEl = document.getElementById('currentChange');
    const change = coin.change;
    changeEl.textContent = (change >= 0 ? '+' : '') + change.toFixed(2) + '%';
    changeEl.className = 'symbol-change ' + (change >= 0 ? 'positive' : 'negative');
}

// Форматирование цены
function formatPrice(price) {
    if (price >= 1000) return price.toFixed(2);
    if (price >= 1) return price.toFixed(4);
    return price.toFixed(6);
}

// === Фильтры ===
function setupFilters() {
    const filters = ['searchFilter', 'changeMin', 'changeMax'];
    filters.forEach(id => {
        document.getElementById(id).addEventListener('input', applyFilters);
    });
    
    // Обработчики для кнопок таймфрейма
    document.querySelectorAll('.tf-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const tf = btn.dataset.tf;
            setTimeframe(tf);
        });
    });
    
    // Обработчики для заголовков сортировки
    document.querySelectorAll('#listHeader span').forEach(span => {
        span.addEventListener('click', () => {
            const field = span.dataset.sort;
            sortBy(field);
        });
    });
}

function applyFilters() {
    const search = document.getElementById('searchFilter').value.toUpperCase();
    const changeMin = parseFloat(document.getElementById('changeMin').value) || -Infinity;
    const changeMax = parseFloat(document.getElementById('changeMax').value) || Infinity;
    
    filteredCoins = Array.from(coins.values()).filter(coin => {
        const matchSearch = coin.symbol.includes(search);
        const matchChange = coin.change >= changeMin && coin.change <= changeMax;
        return matchSearch && matchChange;
    });
    
    sortCoins();
    renderCoinsList();
    updateCoinsCount();
    
    // Переподписываемся на видимые монеты
    updateSubscriptions();
}

// === Сортировка ===
function sortBy(field) {
    if (sortField === field) {
        sortDesc = !sortDesc;
    } else {
        sortField = field;
        sortDesc = true;
    }
    sortCoins();
    renderCoinsList();
}

function sortCoins() {
    filteredCoins.sort((a, b) => {
        let valA = a[sortField];
        let valB = b[sortField];
        
        if (typeof valA === 'string') {
            valA = valA.toLowerCase();
            valB = valB.toLowerCase();
        }
        
        if (valA < valB) return sortDesc ? 1 : -1;
        if (valA > valB) return sortDesc ? -1 : 1;
        return 0;
    });
}

// === Рендер списка монет ===
function renderCoinsList() {
    const container = document.getElementById('coinsList');
    container.innerHTML = '';
    
    filteredCoins.forEach(coin => {
        const row = createCoinRow(coin);
        container.appendChild(row);
    });
}

function createCoinRow(coin) {
    const div = document.createElement('div');
    div.className = 'coin-item' + (coin.symbol === currentSymbol ? ' active' : '');
    div.dataset.symbol = coin.symbol;
    div.onclick = () => selectCoin(coin.symbol);
    
    const changeClass = coin.change >= 0 ? 'positive' : 'negative';
    const changeSign = coin.change >= 0 ? '+' : '';
    
    div.innerHTML = `
        <span class="coin-symbol">${coin.symbol.replace('USDT', '')}</span>
        <span class="coin-price">${formatPrice(coin.price)}</span>
        <span class="coin-change ${changeClass}">${changeSign}${coin.change.toFixed(2)}%</span>
    `;
    
    return div;
}

function updateCoinRow(coin) {
    const row = document.querySelector(`.coin-item[data-symbol="${coin.symbol}"]`);
    if (row) {
        const changeClass = coin.change >= 0 ? 'positive' : 'negative';
        const changeSign = coin.change >= 0 ? '+' : '';
        
        row.children[1].textContent = formatPrice(coin.price);
        row.children[2].textContent = `${changeSign}${coin.change.toFixed(2)}%`;
        row.children[2].className = `coin-change ${changeClass}`;
    }
}

// === Выбор монеты ===
function selectCoin(symbol) {
    currentSymbol = symbol;
    
    // Обновляем активный класс
    document.querySelectorAll('.coin-item').forEach(el => {
        el.classList.toggle('active', el.dataset.symbol === symbol);
    });
    
    loadChartData(symbol);
    updateHeader(symbol);
}

function updateCoinsCount() {
    document.getElementById('coinsCount').textContent = filteredCoins.length;
}

function updateConnectionStatus(connected) {
    const el = document.getElementById('connStatus');
    el.textContent = connected ? 'Connected' : 'Disconnected';
    el.className = 'connection-status ' + (connected ? 'status-connected' : 'status-disconnected');
}

// === Смена таймфрейма ===
function setTimeframe(tf) {
    currentTimeframe = tf;
    
    // Обновляем активную кнопку
    document.querySelectorAll('.tf-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tf === tf);
    });
    
    // Показываем индикатор загрузки
    document.getElementById('currentSymbol').textContent = currentSymbol + ' (' + tf + ')';
    
    // Перезагружаем график и переподписываемся на свечи
    loadChartData(currentSymbol);
}

// Запуск
init();
