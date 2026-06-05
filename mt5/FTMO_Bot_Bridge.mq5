//+------------------------------------------------------------------+
//|  FTMO Bot Bridge - File Based (Mac Compatible)                   |
//+------------------------------------------------------------------+
#property copyright "FTMO Bot"
#property version   "2.0"

input int CHECK_SECS = 5;

ulong    knownPositions[];
datetime lastDayReset = 0;
int      alertedDailyLoss = 0;

int OnInit() {
   EventSetTimer(CHECK_SECS);
   // Load current positions as "known" so we don't fire on startup
   int total = PositionsTotal();
   ArrayResize(knownPositions, total);
   for (int i = 0; i < total; i++)
      knownPositions[i] = PositionGetTicket(i);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) { EventKillTimer(); }

void OnTimer() {
   CheckNewTrades();
   CheckClosedTrades();
   CheckFTMOLimits();
}

void WriteEvent(string json) {
   int handle = FileOpen("ftmo_events.txt", FILE_WRITE|FILE_TXT|FILE_ANSI|FILE_SHARE_READ);
   if (handle == INVALID_HANDLE) {
      handle = FileOpen("ftmo_events.txt", FILE_WRITE|FILE_TXT|FILE_ANSI);
   }
   if (handle != INVALID_HANDLE) {
      FileWrite(handle, json);
      FileClose(handle);
      Print("Event written: ", StringSubstr(json, 0, 80));
   } else {
      Print("ERROR writing file: ", GetLastError());
   }
}

void CheckNewTrades() {
   int total = PositionsTotal();
   ulong current[];
   ArrayResize(current, total);
   for (int i = 0; i < total; i++) current[i] = PositionGetTicket(i);

   for (int i = 0; i < total; i++) {
      ulong ticket = current[i];
      bool isNew = true;
      for (int j = 0; j < ArraySize(knownPositions); j++) {
         if (knownPositions[j] == ticket) { isNew = false; break; }
      }
      if (!isNew) continue;

      if (!PositionSelectByTicket(ticket)) continue;
      string symbol    = PositionGetString(POSITION_SYMBOL);
      int    type      = (int)PositionGetInteger(POSITION_TYPE);
      double entry     = PositionGetDouble(POSITION_PRICE_OPEN);
      double sl        = PositionGetDouble(POSITION_SL);
      double tp        = PositionGetDouble(POSITION_TP);
      double volume    = PositionGetDouble(POSITION_VOLUME);
      string direction = (type == POSITION_TYPE_BUY) ? "לונג" : "שורט";

      string json = StringFormat(
         "{\"event\":\"trade_opened\",\"pair\":\"%s\",\"direction\":\"%s\"," +
         "\"entry\":%.5f,\"sl\":%.5f,\"tp\":%.5f,\"volume\":%.2f,\"ticket\":%d}",
         symbol, direction, entry, sl, tp, volume, (int)ticket
      );
      WriteEvent(json);
   }
   ArrayCopy(knownPositions, current);
}

void CheckClosedTrades() {
   datetime from = (datetime)(TimeCurrent() - CHECK_SECS * 3);
   HistorySelect(from, TimeCurrent());
   int deals = HistoryDealsTotal();

   for (int i = deals - 1; i >= 0; i--) {
      ulong dticket = HistoryDealGetTicket(i);
      if (!HistoryDealSelect(dticket)) continue;
      if ((int)HistoryDealGetInteger(dticket, DEAL_ENTRY) != DEAL_ENTRY_OUT) continue;

      datetime closeTime = (datetime)HistoryDealGetInteger(dticket, DEAL_TIME);
      if (TimeCurrent() - closeTime > CHECK_SECS * 3) continue;

      double profit   = HistoryDealGetDouble(dticket, DEAL_PROFIT)
                      + HistoryDealGetDouble(dticket, DEAL_SWAP)
                      + HistoryDealGetDouble(dticket, DEAL_COMMISSION);
      string symbol   = HistoryDealGetString(dticket, DEAL_SYMBOL);
      ulong posTicket = HistoryDealGetInteger(dticket, DEAL_POSITION_ID);

      string json = StringFormat(
         "{\"event\":\"trade_closed\",\"pair\":\"%s\",\"profit\":%.2f,\"ticket\":%d}",
         symbol, profit, (int)posTicket
      );
      WriteEvent(json);
   }
}

void CheckFTMOLimits() {
   double equity    = AccountInfoDouble(ACCOUNT_EQUITY);
   double startBal  = 100000.0;
   double dailyLoss = startBal - equity;
   double pct       = (dailyLoss / 5000.0) * 100;

   if (pct >= 90 && alertedDailyLoss < 2) {
      alertedDailyLoss = 2;
      WriteEvent("{\"event\":\"ftmo_alert\",\"message\":\"STOP TRADING — daily loss 90%!\"}");
   } else if (pct >= 80 && alertedDailyLoss < 1) {
      alertedDailyLoss = 1;
      WriteEvent(StringFormat("{\"event\":\"ftmo_alert\",\"message\":\"Daily loss %.0f%% — היזהר!\"}",pct));
   }

   datetime today = (datetime)(TimeCurrent() - TimeCurrent() % 86400);
   if (today != lastDayReset) { lastDayReset = today; alertedDailyLoss = 0; }
}
