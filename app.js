// Binance Futures Screener (без ATR)
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

// Инициализация
async function init() {
    await loadCoins();
    initChart();
    connectWebSocket();
    setupFilters();
    loadChartData(currentSymbol);
}

// Загрузка списка фьючерсов и 24h данных (без ATR)
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

        // Заполняем Map монет (без расчёта ATR)
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
        
        updateHeader(symbol);
    } catch (error) {
        console.error('Error loading chart data:', error);
    }
}

// WebSocket подключение
function connectWebSocket() {
    const streams = Array.from(coins.keys())
        .map(s => s.toLowerCase() + '@ticker')
        .slice(0, 100) // Binance лимит ~100 streams
        .join('/');
    
    ws = new WebSocket(`${BINANCE_WS}/stream?streams=${streams}`);
    
    ws.onopen = () => {
        updateConnectionStatus(true);
    };
    
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.data) {
            updateTicker(data.data);
        }
    };
    
    ws.onclose = () => {
        updateConnectionStatus(false);
        setTimeout(connectWebSocket, 5000); // Реконнект
    };
    
    ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        updateConnectionStatus(false);
    };
}

// Обновление тикера из WebSocket
function updateTicker(data) {
    const symbol = data.s.toUpperCase();
    const coin = coins.get(symbol);
    
    if (coin) {
        coin.price = parseFloat(data.c);
        coin.change = parseFloat(data.P);
        
        if (symbol === currentSymbol) {
            updateHeader(symbol);
        }
        
        // Обновляем отображение если монета в отфильтрованном списке
        const index = filteredCoins.findIndex(c => c.symbol === symbol);
        if (index !== -1) {
            updateCoinRow(coin);
        }
    }
}

// Обновление заголовка
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

// Фильтры
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
}

// Сортировка
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

// Рендер списка
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

// Выбор монеты
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

// Смена таймфрейма
function setTimeframe(tf) {
    currentTimeframe = tf;
    
    // Обновляем активную кнопку
    document.querySelectorAll('.tf-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.tf === tf);
    });
    
    // Показываем индикатор загрузки
    document.getElementById('currentSymbol').textContent = currentSymbol + ' (' + tf + ')';
    
    // Перезагружаем график
    loadChartData(currentSymbol);
}

// Запуск
init();
