// Tilin datan kartta: kokoelma -> taulu ja omistajasarake.
//
// TÄMÄ ON KOPIO src/domain/accountLifecycle.js:n ACCOUNT_DATA_MAP:ista.
// Edge Function ei voi tuoda selainpuolen src/-hakemistoa (se ei kuulu
// funktion pakettiin), joten kartta on tässä erikseen. Kopio EI SAA
// erkaantua: tests/account-deletion-inventory.test.mjs vaatii sen
// täsmälleen samaksi ja sen, että se kattaa jokaisen viennin kokoelman.
// Muokkaa ENSIN src/-puolta, kopioi sitten tähän.

export const ACCOUNT_DATA_MAP = Object.freeze({
  tasks: { table: 'tasks', ownerColumn: 'user_id' },
  routines: { table: 'routines', ownerColumn: 'user_id' },
  routineExceptions: { table: 'routine_exceptions', ownerColumn: 'user_id' },
  goals: { table: 'goals', ownerColumn: 'user_id' },
  projects: { table: 'projects', ownerColumn: 'user_id' },
  bills: { table: 'bills', ownerColumn: 'user_id' },
  recurringExpenses: { table: 'recurring_expenses', ownerColumn: 'user_id' },
  savingsGoals: { table: 'savings_goals', ownerColumn: 'user_id' },
  wellbeing: { table: 'wellbeing_entries', ownerColumn: 'user_id' },
  notificationPreferences: { table: 'notification_preferences', ownerColumn: 'id' },
  profile: { table: 'profile', ownerColumn: 'id' },
  aiAudit: { table: 'ai_action_audit', ownerColumn: 'user_id' },
  transactions: { table: 'transactions', ownerColumn: 'user_id' },
  investments: { table: 'investments', ownerColumn: 'user_id' },
  milestones: { table: 'milestones', ownerColumn: 'user_id' },
  inboxItems: { table: 'inbox_items', ownerColumn: 'user_id' },
  reminders: { table: 'reminders', ownerColumn: 'user_id' },
  notices: { table: 'notices', ownerColumn: 'user_id' },
  travelPlans: { table: 'travel_plans', ownerColumn: 'user_id' },
  locationRules: { table: 'location_rules', ownerColumn: 'user_id' },
  lifeAreas: { table: 'life_areas', ownerColumn: 'user_id' },
  weeklyCapacities: { table: 'weekly_capacities', ownerColumn: 'user_id' },
  timeEntries: { table: 'time_entries', ownerColumn: 'user_id' },
  alignmentReviews: { table: 'alignment_reviews', ownerColumn: 'user_id' },
  alignmentItemSettings: { table: 'alignment_item_settings', ownerColumn: 'user_id' },
  runningTimers: { table: 'running_timers', ownerColumn: 'user_id' }
});
