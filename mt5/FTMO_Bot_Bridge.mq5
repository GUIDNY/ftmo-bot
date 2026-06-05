//+------------------------------------------------------------------+
//|  FTMO Bot Bridge EA                                              |
//|  שולח אירועים לבוט WhatsApp בזמן אמת                           |
//+------------------------------------------------------------------+
#property copyright "FTMO Bot"
#property version   "1.0"
#property strict

// ── Settings ──
input string BOT_URL    = "https://endearing-vitality-production-5bfb.up.railway.app";
input string API_KEY    = "ftmo_bridge_2024";
input string PHONE      = "972547701899";
input int    CHECK_SECS = 10;  // כל כמה שניות לבדוק

// ── State ──
ulong    lastPositions[];
datetime lastCheckTime = 0;
double   lastBalance   = 0;
int      alertedDailyLoss = 0; // 0=none, 1=80%, 2=90%

//+------------------------------------------------------------------+
int OnInit() {
   EventSetTimer(CHECK_SECS);
   ArrayResize(lastPositions, 0);
   lastBalance = AccountInfoDouble(ACCOUNT_BALANCE);
   Print("FTMO Bot Bridge initialized. URL: ", BOT_URL);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) {
   EventKillTimer();
}

//+------------------------------------------------------------------+
void OnTimer() {
   CheckNewTrades();
   CheckClosedTrades();
   CheckFTMOLimits();
}

//+------------------------------------------------------------------+
void CheckNewTrades() {
   int total = PositionsTotal();

   for (int i = 0; i < total; i++) {
      ulong ticket = PositionGetTicket(i);
      if (!PositionSelectByTicket(ticket)) continue;

      // Check if this is a new position
      bool isNew = true;
      for (int j = 0; j < ArraySize(lastPositions); j++) {
         if (lastPositions[j] == ticket) { isNew = false; break; }
      }

      if (isNew) {
         string symbol  = PositionGetString(POSITION_SYMBOL);
         int    type    = (int)PositionGetInteger(POSITION_TYPE);
         double entry   = PositionGetDouble(POSITION_PRICE_OPEN);
         double sl      = PositionGetDouble(POSITION_SL);
         double tp      = PositionGetDouble(POSITION_TP);
         double volume  = PositionGetDouble(POSITION_VOLUME);
         double profit  = PositionGetDouble(POSITION_PROFIT);

         string direction = (type == POSITION_TYPE_BUY) ? "לונג" : "שורט";

         string body = StringFormat(
            "{\"key\":\"%s\",\"phone\":\"%s\",\"event\":\"trade_opened\"," +
            "\"pair\":\"%s\",\"direction\":\"%s\",\"entry\":%.5f," +
            "\"sl\":%.5f,\"tp\":%.5f,\"volume\":%.2f,\"ticket\":%d}",
            API_KEY, PHONE, symbol, direction, entry, sl, tp, volume, (int)ticket
         );

         SendToBot("/api/mt5/trade-opened", body);

         // Add to known list
         int size = ArraySize(lastPositions);
         ArrayResize(lastPositions, size + 1);
         lastPositions[size] = ticket;

         Print("New trade detected: ", symbol, " ", direction, " #", ticket);
      }
   }

   // Update known positions list to current open ones
   int total2 = PositionsTotal();
   ulong current[];
   ArrayResize(current, total2);
   for (int i = 0; i < total2; i++) current[i] = PositionGetTicket(i);
   ArrayCopy(lastPositions, current);
}

//+------------------------------------------------------------------+
void CheckClosedTrades() {
   datetime from = (datetime)(TimeCurrent() - CHECK_SECS * 2);

   HistorySelect(from, TimeCurrent());
   int deals = HistoryDealsTotal();

   for (int i = deals - 1; i >= 0; i--) {
      ulong dticket = HistoryDealGetTicket(i);
      if (!HistoryDealSelect(dticket)) continue;

      int dealType = (int)HistoryDealGetInteger(dticket, DEAL_TYPE);
      int entry    = (int)HistoryDealGetInteger(dticket, DEAL_ENTRY);

      // Only closing deals
      if (entry != DEAL_ENTRY_OUT) continue;

      double profit  = HistoryDealGetDouble(dticket, DEAL_PROFIT);
      double swap    = HistoryDealGetDouble(dticket, DEAL_SWAP);
      double commission = HistoryDealGetDouble(dticket, DEAL_COMMISSION);
      double netProfit = profit + swap + commission;
      string symbol  = HistoryDealGetString(dticket, DEAL_SYMBOL);
      datetime closeTime = (datetime)HistoryDealGetInteger(dticket, DEAL_TIME);
      ulong posTicket = HistoryDealGetInteger(dticket, DEAL_POSITION_ID);

      // Only deals closed in last CHECK_SECS*2 seconds
      if (TimeCurrent() - closeTime > CHECK_SECS * 2) continue;

      string body = StringFormat(
         "{\"key\":\"%s\",\"phone\":\"%s\",\"event\":\"trade_closed\"," +
         "\"pair\":\"%s\",\"profit\":%.2f,\"ticket\":%d}",
         API_KEY, PHONE, symbol, netProfit, (int)posTicket
      );

      SendToBot("/api/mt5/trade-closed", body);
      Print("Trade closed: ", symbol, " P&L: ", netProfit);
   }
}

//+------------------------------------------------------------------+
void CheckFTMOLimits() {
   double balance   = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity    = AccountInfoDouble(ACCOUNT_EQUITY);
   double startBal  = 100000.0; // גודל חשבון FTMO
   double dailyLoss = startBal - equity;
   double maxDaily  = 5000.0;   // FTMO daily limit $5,000
   double maxDD     = 10000.0;  // FTMO max drawdown $10,000
   double pct       = (dailyLoss / maxDaily) * 100;

   // Alert at 80%
   if (pct >= 80 && alertedDailyLoss < 1) {
      alertedDailyLoss = 1;
      string body = StringFormat(
         "{\"key\":\"%s\",\"phone\":\"%s\",\"event\":\"ftmo_alert\"," +
         "\"message\":\"⚠️ Daily loss %.0f%% — $%.0f מתוך $%.0f הגבלה!\"}",
         API_KEY, PHONE, pct, dailyLoss, maxDaily
      );
      SendToBot("/api/mt5/alert", body);
   }
   // Alert at 90% - STOP TRADING
   if (pct >= 90 && alertedDailyLoss < 2) {
      alertedDailyLoss = 2;
      string body = StringFormat(
         "{\"key\":\"%s\",\"phone\":\"%s\",\"event\":\"ftmo_alert\"," +
         "\"message\":\"🚨 STOP TRADING! Daily loss %.0f%% — סגור הכל עכשיו!\"}",
         API_KEY, PHONE, pct
      );
      SendToBot("/api/mt5/alert", body);
   }

   // Reset alert counter at start of new day
   static datetime lastDay = 0;
   datetime today = (datetime)(TimeCurrent() - TimeCurrent() % 86400);
   if (today != lastDay) {
      lastDay = today;
      alertedDailyLoss = 0;

      // Send account update
      string body = StringFormat(
         "{\"key\":\"%s\",\"phone\":\"%s\",\"event\":\"account_update\"," +
         "\"balance\":%.2f,\"equity\":%.2f,\"profit\":%.2f}",
         API_KEY, PHONE, balance, equity, equity - balance
      );
      SendToBot("/api/mt5/account-update", body);
   }
}

//+------------------------------------------------------------------+
void SendToBot(string endpoint, string body) {
   string url     = BOT_URL + endpoint;
   string headers = "Content-Type: application/json\r\n";
   char   post[];
   char   result[];
   string resultHeaders;

   StringToCharArray(body, post, 0, StringLen(body));

   int res = WebRequest("POST", url, headers, 5000, post, result, resultHeaders);

   if (res == -1) {
      int err = GetLastError();
      Print("WebRequest error: ", err, " — הוסף את ה-URL ב-Tools > Options > Expert Advisors");
   } else {
      Print("Sent to bot: ", endpoint, " → ", res);
   }
}
//+------------------------------------------------------------------+
