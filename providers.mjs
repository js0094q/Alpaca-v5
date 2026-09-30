import { observe } from './telemetry/trace.mjs';
import { decode, encode } from '@msgpack/msgpack';
import { WebSocket as DefaultWebSocket } from 'ws';
import { normalizeTradeUpdate } from './alpaca.mjs';

const PAPER_URL = 'https://paper-api.alpaca.markets';
const LIVE_URL = 'https://api.alpaca.markets';
const DATA_URL = 'https://data.alpaca.markets';
const SIP_WS = 'wss://stream.data.alpaca.markets/v2/sip';
const OPRA_WS = 'wss://stream.data.alpaca.markets/v1beta1/opra';
const ET = 'America/New_York';

const json = async (response) => {
  const body = await response.text();
  if (!response.ok) { const error = new Error('Alpaca request failed'); error.httpStatus = response.status; throw error; }
  return body ? JSON.parse(body) : null;
};

const dateInET = (value) => new Intl.DateTimeFormat('en-CA', {
  timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date(value));

const offsetAt = (utcMs) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: ET, timeZoneName: 'longOffset' }).formatToParts(new Date(utcMs));
  const offset = parts.find(({ type }) => type === 'timeZoneName')?.value ?? 'GMT';
  const m = offset.match(/GMT([+-])(\d{2})(?::(\d{2}))?/);
  if (!m) return 0;
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
  return (m[1] === '-' ? -1 : 1) * minutes * 60_000;
};

const localET = (date, clock) => {
  const [hour, minute] = String(clock).slice(0, 5).split(':').map(Number);
  const [year, month, day] = date.split('-').map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  return new Date(wall - offsetAt(wall)).toISOString();
};

const asSymbols = (symbols) => [...new Set((symbols ?? []).filter((symbol) => typeof symbol === 'string' && symbol))];

export function createCalendar({ fetchImpl = fetch, key, secret, baseUrl, telemetry } = {}) {
  if (![PAPER_URL, LIVE_URL].includes(baseUrl)) throw new Error('Unsupported Alpaca API URL');
  const rows = new Map();
  let ordered = [];
  const request = (path) => {
    const failed = (error) => observe(telemetry, 'calendar_api_error', { path, errorName: error?.name, httpStatus: error?.httpStatus });
    try {
      const pending = fetchImpl(`${baseUrl}${path}`, { headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret } }).then(json);
      void pending.then(undefined, failed);
      return pending;
    } catch (error) { failed(error); throw error; }
  };

  const loadCalendar = async ({ start, end }) => {
    if (!start || !end) throw new TypeError('calendar start and end are required');
    const values = await request(`/v2/calendar?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}`);
    for (const row of values ?? []) {
      if (!row?.date || !row.open || !row.close) continue;
      rows.set(row.date, {
        date: row.date,
        open: localET(row.date, row.open),
        close: localET(row.date, row.close),
      });
    }
    ordered = [...rows.values()].sort((a, b) => a.date.localeCompare(b.date));
    return ordered.filter(({ date }) => date >= start && date <= end).map((row) => ({ ...row, status: 'closed' }));
  };

  const sessionFor = (now = Date.now()) => {
    const ms = typeof now === 'number' ? now : Date.parse(now);
    if (!Number.isFinite(ms)) throw new TypeError('now must be a timestamp');
    const date = dateInET(ms);
    const current = rows.get(date);
    const currentOpen = current && ms >= Date.parse(current.open) && ms < Date.parse(current.close);
    const next = ordered.find((row) => Date.parse(row.open) > ms);
    if (!current) return next ? { ...next, status: 'closed', nextOpen: next.open, nextDate: next.date } : { date, status: 'closed' };
    return {
      ...current,
      status: currentOpen ? 'open' : 'closed',
      ...(next ? { nextOpen: next.open, nextDate: next.date } : {}),
    };
  };

  return { loadCalendar, sessionFor };
}

function attach(socket, handlers) {
  if (typeof socket.addEventListener === 'function') {
    for (const [event, handler] of Object.entries(handlers)) socket.addEventListener(event, handler);
  } else {
    for (const [event, handler] of Object.entries(handlers)) socket.on(event, handler);
  }
}

const send = (socket, value, format = 'json') => socket?.readyState === 1 && socket.send(format === 'msgpack' ? encode(value) : JSON.stringify(value));

const frames = (value, format = 'json') => {
  if (value?.data !== undefined && typeof value !== 'string' && !(value instanceof ArrayBuffer) && !ArrayBuffer.isView(value)) return frames(value.data, format);
  if (typeof value === 'string') return JSON.parse(value);
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return format === 'msgpack' ? decode(bytes) : JSON.parse(new TextDecoder().decode(bytes));
  }
  return value;
};

const eachFrame = (message, callback) => {
  for (const frame of (Array.isArray(message) ? message : [message])) callback(frame);
};

const rawTrade = (frame) => ({
  symbol: frame.S,
  price: frame.p == null ? undefined : Number(frame.p),
  timestamp: frame.t instanceof Date ? frame.t.toISOString() : frame.t,
  conditions: frame.c ?? [],
  tradeId: frame.i,
  exchange: frame.x,
  tape: frame.z,
  rawType: frame.T,
  raw: frame,
});

const quote = (frame) => ({ symbol: frame.S, bid: Number(frame.bp), ask: Number(frame.ap), timestamp: frame.t instanceof Date ? frame.t.toISOString() : frame.t, raw: frame });

export function createAlpacaProviders({ key, secret, fetchImpl = fetch, WebSocketImpl = DefaultWebSocket, baseUrl, telemetry } = {}) {
  if (!key || !secret) throw new TypeError('Alpaca credentials are required');
  if (![PAPER_URL, LIVE_URL].includes(baseUrl)) throw new Error('Unsupported Alpaca API URL');
  const tradeWs = `${baseUrl.replace(/^https:/, 'wss:')}/stream`;
  const request = (url, options = {}) => {
    const failed = (error) => observe(telemetry, 'provider_api_error', { path: new URL(url).pathname, errorName: error?.name, httpStatus: error?.httpStatus });
    try {
      const pending = fetchImpl(url, { ...options, headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret, ...(options.headers ?? {}) } }).then(json);
      void pending.then(undefined, failed);
      return pending;
    } catch (error) { failed(error); throw error; }
  };
  const calendar = createCalendar({ fetchImpl, key, secret, baseUrl, telemetry });

  const getContracts = async (direction, timestamp) => {
    if (!['CALL', 'PUT'].includes(direction)) throw new TypeError('direction must be CALL or PUT');
    const date = dateInET(timestamp);
    const type = direction === 'CALL' ? 'call' : 'put';
    const result = [];
    let pageToken;
    do {
      const query = new URLSearchParams({ underlying_symbols: 'SPY', expiration_date: date, type, status: 'active', limit: '10000' });
      if (pageToken) query.set('page_token', pageToken);
      const page = await request(`${baseUrl}/v2/options/contracts?${query}`);
      for (const item of page?.option_contracts ?? page?.contracts ?? []) {
        const contractSize = Number(item?.multiplier ?? item?.size);
        if (item?.symbol && Number.isFinite(Number(item.strike_price))) result.push({ symbol: item.symbol, strike: Number(item.strike_price), ...(Number.isFinite(contractSize) && contractSize > 0 ? { contractSize } : {}) });
      }
      pageToken = page?.next_page_token ?? null;
    } while (pageToken);
    return result;
  };

  const getQuote = async (symbol) => {
    const query = new URLSearchParams({ symbols: symbol, feed: 'opra' });
    const result = await request(`${DATA_URL}/v1beta1/options/quotes/latest?${query}`);
    const row = result?.quotes?.[symbol] ?? result?.[symbol];
    return row ? { symbol, bid: Number(row.bp), ask: Number(row.ap), timestamp: row.t } : null;
  };
  const getLatestTrade = async () => {
    const result = await request(`${DATA_URL}/v2/stocks/SPY/trades/latest?feed=sip`);
    const row = result?.trade ?? result?.SPY ?? result;
    return row?.p == null ? null : { symbol: 'SPY', price: Number(row.p), timestamp: row.t };
  };

  const connect = ({ onRawTrade = () => {}, onQuote = () => {}, onTradeUpdate = () => {}, onDisconnect = () => {}, onStatus = () => {}, optionSymbols = [] } = {}) => {
    let stopped = false;
    let subscriptions = asSymbols(optionSymbols);
    const open = (url, headers, format, onFrame) => {
      const state = { socket: null, timer: null, attempt: 0, authenticated: false, confirmed: false, failed: false, quotes: new Set() };
      const status = (name, fields = {}) => onStatus({ stream: url, status: name, ...fields });
      const failed = (socket, event, error) => {
        if (stopped || state.socket !== socket || state.failed) return;
        state.failed = true;
        state.authenticated = false;
        state.confirmed = false;
        state.quotes.clear();
        status('disconnected', { event, error });
        onDisconnect({ stream: url, event, error });
        try { socket?.close?.(); } catch {}
        const delay = Math.min(5_000, 500 * 2 ** Math.min(state.attempt, 4));
        state.timer = setTimeout(() => {
          state.timer = null;
          if (stopped) return;
          state.attempt++;
          status('reconnecting', { attempt: state.attempt });
          launch();
        }, delay);
      };
      const write = (value) => {
        const socket = state.socket;
        if (!socket || socket.readyState !== 1) return false;
        try { send(socket, value, format); return true; }
        catch (error) { failed(socket, undefined, error); return false; }
      };
      const confirm = (name, frame) => {
        if (state.confirmed) return;
        state.confirmed = true;
        status(name, { frame });
        if (state.attempt) {
          status('reconnected', { attempt: state.attempt, frame });
          state.attempt = 0;
        }
      };
      const launch = () => {
        let socket;
        try { socket = headers ? new WebSocketImpl(url, { headers }) : new WebSocketImpl(url); }
        catch (error) { state.socket = null; state.failed = false; failed(null, undefined, error); return; }
        state.socket = socket;
        state.failed = false;
        state.authenticated = false;
        state.confirmed = false;
        state.quotes.clear();
        attach(socket, {
          open: () => { if (!stopped && state.socket === socket) { status('connected'); write({ action: 'auth', key, secret }); } },
          message: (event) => {
            if (stopped || state.socket !== socket || state.failed) return;
            try { eachFrame(frames(event, format), (frame) => { if (!stopped && state.socket === socket && !state.failed) onFrame(frame, state, status, write, confirm, failed); }); }
            catch (error) { status('decode_error', { error }); failed(socket, undefined, error); }
          },
          error: (error) => { if (state.socket === socket && !state.failed) { status('error', { error }); failed(socket, undefined, error); } },
          close: (event, reason) => failed(socket, typeof event === 'number' ? { code: event, reason } : event, undefined),
        });
      };
      launch();
      return { state, write, stop: (message) => {
        clearTimeout(state.timer);
        const socket = state.socket;
        state.socket = null;
        try { if (message) send(socket, message, format); } catch {}
        try { socket?.close?.(); } catch {}
      } };
    };
    const sip = open(SIP_WS, null, 'json', (frame, state, status, write, confirm, failed) => {
      if (frame?.T === 'success' && frame.msg === 'authenticated' && !state.authenticated) { state.authenticated = true; status('authenticated', { frame }); write({ action: 'subscribe', trades: ['SPY'] }); }
      else if (frame?.T === 'subscription' && state.authenticated && Array.isArray(frame.trades) && frame.trades.includes('SPY')) confirm('subscription_confirmed', frame);
      else if (frame?.T === 'error') failed(state.socket, frame, undefined);
      if (['success', 'subscription', 'error'].includes(frame?.T)) onStatus({ stream: SIP_WS, frame });
      else if (state.confirmed && ['t', 'c', 'x'].includes(frame?.T) && frame.S === 'SPY') onRawTrade(rawTrade(frame));
    });
    const opra = open(OPRA_WS, { 'Content-Type': 'application/msgpack' }, 'msgpack', (frame, state, status, write, confirm, failed) => {
      if (frame?.T === 'success' && frame.msg === 'authenticated' && !state.authenticated) { state.authenticated = true; status('authenticated', { frame }); if (subscriptions.length) write({ action: 'subscribe', quotes: subscriptions }); }
      else if (frame?.T === 'subscription' && state.authenticated && Array.isArray(frame.quotes)) {
        state.quotes = new Set(asSymbols(frame.quotes));
        if (subscriptions.every((symbol) => state.quotes.has(symbol))) confirm('subscription_confirmed', frame);
      } else if (frame?.T === 'error') failed(state.socket, frame, undefined);
      if (['success', 'subscription', 'error'].includes(frame?.T)) onStatus({ stream: OPRA_WS, frame });
      else if (frame?.T === 'q' && state.quotes.has(frame.S)) onQuote(quote(frame));
    });
    const trades = open(tradeWs, null, 'json', (frame, state, status, write, confirm, failed) => {
      if (frame?.stream === 'authorization' && frame.data?.status === 'authorized' && !state.authenticated) { state.authenticated = true; status('authenticated', { frame }); write({ action: 'listen', data: { streams: ['trade_updates'] } }); }
      else if (frame?.stream === 'listening' && state.authenticated && Array.isArray(frame.data?.streams) && frame.data.streams.includes('trade_updates')) confirm('listening_confirmed', frame);
      else if (frame?.stream === 'error' || frame?.stream === 'authorization' && frame.data?.status !== 'authorized') failed(state.socket, frame, undefined);
      if (frame?.stream !== 'trade_updates') onStatus({ stream: tradeWs, frame });
      else if (state.confirmed) onTradeUpdate(normalizeTradeUpdate(frame.data ?? frame));
    });
    return {
      subscribeOptions(symbols) {
        if (stopped) return;
        const next = asSymbols(symbols);
        const added = next.filter((symbol) => !subscriptions.includes(symbol));
        subscriptions = [...subscriptions, ...added];
        if (opra.state.authenticated && added.length) opra.write({ action: 'subscribe', quotes: added });
      },
      stop() {
        if (stopped) return;
        stopped = true;
        sip.stop({ action: 'unsubscribe', trades: ['SPY'] });
        opra.stop(subscriptions.length ? { action: 'unsubscribe', quotes: subscriptions } : null);
        trades.stop({ action: 'listen', data: { streams: [] } });
      },
    };
  };

  return { getContracts, getQuote, getLatestTrade, calendar, connect };
}
