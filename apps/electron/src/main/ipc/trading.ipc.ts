import { ipcMain } from 'electron'
import { FUND_STOCK_IPC_CHANNELS } from '@copis/shared'
import type { KlinePeriod, WatchlistItem } from '@copis/shared'
import { fetchMarketQuotes, fetchKlines, searchSymbols, getWatchlist, saveWatchlist } from '../lib/trading-quote-service'
import { getDshTradingStatus, startDshTradingServer, stopDshTradingServer } from '../lib/dsh-trading-service'

export function registerTradingIpcHandlers(): void {
  // ===== 基金股市（美股、A 股、港股、基金）通道 =====
  ipcMain.handle(
    FUND_STOCK_IPC_CHANNELS.GET_QUOTE,
    async (_, symbols: string[] | string) => {
      const list = Array.isArray(symbols) ? symbols : [symbols]
      return fetchMarketQuotes(list)
    }
  )

  ipcMain.handle(
    FUND_STOCK_IPC_CHANNELS.GET_KLINES,
    async (_, symbol: string, period?: KlinePeriod, count?: number) => {
      return fetchKlines(symbol, period, count)
    }
  )

  ipcMain.handle(
    FUND_STOCK_IPC_CHANNELS.SEARCH_SYMBOLS,
    async (_, keyword: string) => {
      return searchSymbols(keyword)
    }
  )

  ipcMain.handle(
    FUND_STOCK_IPC_CHANNELS.GET_WATCHLIST,
    () => {
      return getWatchlist()
    }
  )

  ipcMain.handle(
    FUND_STOCK_IPC_CHANNELS.SAVE_WATCHLIST,
    (_, items: WatchlistItem[]) => {
      saveWatchlist(items)
      return { success: true }
    }
  )

  ipcMain.handle(
    FUND_STOCK_IPC_CHANNELS.TERMINAL_STATUS,
    () => {
      return getDshTradingStatus()
    }
  )

  ipcMain.handle(
    FUND_STOCK_IPC_CHANNELS.START_TERMINAL,
    async () => {
      return startDshTradingServer()
    }
  )

  ipcMain.handle(
    FUND_STOCK_IPC_CHANNELS.STOP_TERMINAL,
    () => {
      return stopDshTradingServer()
    }
  )
}
