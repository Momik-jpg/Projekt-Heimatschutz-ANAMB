import { RECONCILIATION_STATUS } from "../domain/sourceReconciliation.js";

const inactiveReconciliationStatuses = [
  RECONCILIATION_STATUS.MISSING_PUBLICATION,
  RECONCILIATION_STATUS.CONFLICT_REVIEW,
  RECONCILIATION_STATUS.AMBIGUOUS_REVIEW,
  RECONCILIATION_STATUS.IMPORT_REVIEW,
  "unclear",
  "ambiguous"
];

const inactiveReconciliationStatusSql = inactiveReconciliationStatuses.map((status) => `'${status}'`).join(", ");

export const activeReconciliationCondition = `IFNULL(reconciliation_status, '') NOT IN (${inactiveReconciliationStatusSql})`;
