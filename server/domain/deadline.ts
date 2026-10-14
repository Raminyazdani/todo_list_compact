import type { TaskDTO } from "../../shared/contracts";
import { instantToLocalDate } from "../../shared/datetime";
import { closed } from "./core";

/** Either explicit deadline may expire. A date label has no invented midnight. */
export function expiredDeadlineDates(
  task: TaskDTO,
  zone = "Europe/Berlin",
  at = Date.now(),
): string[] {
  if (task.archived_at || closed(task.status)) return [];
  const today = instantToLocalDate(at, zone),
    labels: string[] = [];
  if (task.due_date && task.due_date < today) labels.push(task.due_date);
  if (task.due_at && Date.parse(task.due_at) < at)
    labels.push(instantToLocalDate(task.due_at, zone));
  return [...new Set(labels)].sort();
}
export function taskOverdue(
  task: TaskDTO,
  zone = "Europe/Berlin",
  at = Date.now(),
): boolean {
  return expiredDeadlineDates(task, zone, at).length > 0;
}
