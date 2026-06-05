//+------------------------------------------------------------------+
//|  FTMO Bot Bridge v3 - Position tracking (no duplicate events)    |
//+------------------------------------------------------------------+
#property copyright "FTMO Bot"
#property version   "3.0"

input string BOT_URL   = "https://endearing-vitality-production-5bfb.up.railway.app";
input string API_KEY   = "ftmo_bridge_2024";
input string PHONE     = "972547701899";
input int    CHECK_SECS = 5;

struct PositionInfo {
   ulong  ticket;
   string symbol;
   int    type;
   double entry;
   double sl;
   double tp;
   double volume;
};

PositionInfo prevPositions[];
bool initialized = false;
int  alertedDailyLoss = 0;

int OnInit() {
   EventSetTimer(CHECK_SECS);
   // Load current positions as baseline — no events on startup
   SnapshotPositions(prevPositions);
   initialized = true;
   Print("FTMO Bot Bridge v3 started. Tracking ", ArraySize(prevPositions), " open positions.");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) { EventKillTimer(); }

void OnTimer() {
   if (!initialized) return;

   PositionInfo currPositions[];
   SnapshotPositions(currPositions);

   // Find NEW positions (in curr but not in prev) → trade opened
   for (int i = 0; i < ArraySize(currPositions); i++) {
      bool found = false;
      for (int j = 0; j < ArraySize(prevPositions); j++)
         if (prevPositions[j].ticket == currPositions[i].ticket) { found = true; break; }
      if (!found) OnTradeOpened(currPositions[i]);
   }

   // Find CLOSED positions (in prev but not in curr) → trade closed
   for (int i = 0; i < ArraySize(prevPositions); i++) {
      bool found = false;
      for (int j = 0; j < ArraySize(currPositions); j++)
         if (currPositions[j].ticket == prevPositions[i].ticket) { found = true; break; }
      if (!found) OnTradeClosed(prevPositions[i]);
   }

   // Update snapshot
   int sz = ArraySize(currPositions);
   ArrayResize(prevPositions, sz);
   for (int i = 0; i < sz; i++) prevPositions[i] = currPositions[i];

   CheckFTMOLimits();
}

void SnapshotPositions(PositionInfo &arr[]) {
   int total = PositionsTotal();
   ArrayResize(arr, total);
   for (int i = 0; i < total; i++) {
      ulong ticket = PositionGetTicket(i);
      if (!PositionSelectByTicket(ticket)) continue;
      arr[i].ticket = ticket;
      arr[i].symbol = PositionGetString(POSITION_SYMBOL);
      arr[i].type   = (int)PositionGetInteger(POSITION_TYPE);
      arr[i].entry  = PositionGetDouble(POSITION_PRICE_OPEN);
      arr[i].sl     = PositionGetDouble(POSITION_SL);
      arr[i].tp     = PositionGetDouble(POSITION_TP);
      arr[i].volume = PositionGetDouble(POSITION_VOLUME);
   }
}

void OnTradeOpened(PositionInfo &pos) {
   string dir = (pos.type == 0) ? "לונג" : "שורט";
   string body = StringFormat(
      "{\"key\":\"%s\",\"phone\":\"%s\",\"event\":\"trade_opened\"," +
      "\"pair\":\"%s\",\"direction\":\"%s\",\"entry\":%.5f," +
      "\"sl\":%.5f,\"tp\":%.5f,\"volume\":%.2f,\"ticket\":%d}",
      API_KEY, PHONE, pos.symbol, dir, pos.entry, pos.sl, pos.tp, pos.volume, (int)pos.ticket
   );
   SendToBot("/api/mt5/trade-opened", body);
   Print("Trade opened: ", pos.symbol, " ", dir, " #", pos.ticket);
}

void OnTradeClosed(PositionInfo &pos) {
   // Get P&L from history
   double profit = GetPositionProfit(pos.ticket);
   string body = StringFormat(
      "{\"key\":\"%s\",\"phone\":\"%s\",\"event\":\"trade_closed\"," +
      "\"pair\":\"%s\",\"profit\":%.2f,\"ticket\":%d}",
      API_KEY, PHONE, pos.symbol, profit, (int)pos.ticket
   );
   SendToBot("/api/mt5/trade-closed", body);
   Print("Trade closed: ", pos.symbol, " P&L: ", profit);
}

double GetPositionProfit(ulong ticket) {
   HistorySelect(TimeCurrent() - 86400, TimeCurrent());
   int deals = HistoryDealsTotal();
   double total = 0;
   for (int i = 0; i < deals; i++) {
      ulong d = HistoryDealGetTicket(i);
      if (HistoryDealGetInteger(d, DEAL_POSITION_ID) != (long)ticket) continue;
      total += HistoryDealGetDouble(d, DEAL_PROFIT)
             + HistoryDealGetDouble(d, DEAL_SWAP)
             + HistoryDealGetDouble(d, DEAL_COMMISSION);
   }
   return total;
}

void CheckFTMOLimits() {
   double equity    = AccountInfoDouble(ACCOUNT_EQUITY);
   double dailyLoss = 100000.0 - equity;
   double pct       = (dailyLoss / 5000.0) * 100;

   if (pct >= 90 && alertedDailyLoss < 2) {
      alertedDailyLoss = 2;
      string body = StringFormat("{\"key\":\"%s\",\"phone\":\"%s\",\"event\":\"ftmo_alert\",\"message\":\"🚨 STOP — daily loss 90%%!\"}",API_KEY,PHONE);
      SendToBot("/api/mt5/alert", body);
   } else if (pct >= 80 && alertedDailyLoss < 1) {
      alertedDailyLoss = 1;
      string body = StringFormat("{\"key\":\"%s\",\"phone\":\"%s\",\"event\":\"ftmo_alert\",\"message\":\"⚠️ Daily loss %.0f%%\"}",API_KEY,PHONE,pct);
      SendToBot("/api/mt5/alert", body);
   }

   static datetime lastDay = 0;
   datetime today = (datetime)(TimeCurrent() - TimeCurrent() % 86400);
   if (today != lastDay) { lastDay = today; alertedDailyLoss = 0; }
}

void SendToBot(string endpoint, string body) {
   string headers = "Content-Type: application/json\r\n";
   char post[], result[];
   string resHeaders;
   StringToCharArray(body, post, 0, StringLen(body));
   int res = WebRequest("POST", BOT_URL + endpoint, headers, 5000, post, result, resHeaders);
   if (res == -1) Print("WebRequest error: ", GetLastError());
   else Print("Sent: ", endpoint, " → ", res);
}
