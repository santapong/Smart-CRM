import Link from "next/link";
import {
  startOfMonth,
  endOfMonth,
  startOfWeek,
  endOfWeek,
  eachDayOfInterval,
  format,
  isSameMonth,
  isSameDay,
  isToday,
  parse,
  isValid,
} from "date-fns";
import { db } from "@/lib/db";
import { requireOrg } from "@/lib/tenant";
import { PageHeader } from "@/components/page-header";
import { cn } from "@/lib/utils";
import { MonthNav } from "./month-nav";
import { CompleteToggle } from "./complete-toggle";

export const dynamic = "force-dynamic";

type ActivityType = "TASK" | "CALL" | "MEETING" | "NOTE";

// Color per activity type; deal close dates get their own accent.
const TYPE_COLOR: Record<ActivityType, string> = {
  TASK: "bg-sky-500",
  CALL: "bg-violet-500",
  MEETING: "bg-amber-500",
  NOTE: "bg-slate-400",
};
const DEAL_COLOR = "bg-emerald-500";

type CalEvent = {
  id: string;
  date: Date;
  title: string;
  href: string;
  color: string;
  kind: "activity" | "deal";
  activityType?: ActivityType;
  completed?: boolean;
};

function parseMonth(raw: string | undefined): Date {
  if (raw) {
    const d = parse(raw, "yyyy-MM", new Date());
    if (isValid(d)) return d;
  }
  return new Date();
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string }>;
}) {
  const { orgId } = await requireOrg();
  const { month: monthParam } = await searchParams;
  const anchor = parseMonth(monthParam);
  const monthStr = format(anchor, "yyyy-MM");

  // The visible grid spans whole weeks around the month.
  const gridStart = startOfWeek(startOfMonth(anchor));
  const gridEnd = endOfWeek(endOfMonth(anchor));

  const [activities, deals] = await Promise.all([
    db.activity.findMany({
      where: { orgId, dueAt: { gte: gridStart, lte: gridEnd } },
      orderBy: { dueAt: "asc" },
      select: { id: true, title: true, type: true, dueAt: true, completedAt: true, dealId: true, contactId: true },
    }),
    db.deal.findMany({
      where: { orgId, closeDate: { gte: gridStart, lte: gridEnd } },
      orderBy: { closeDate: "asc" },
      select: { id: true, title: true, closeDate: true },
    }),
  ]);

  const events: CalEvent[] = [
    ...activities.map((a): CalEvent => ({
      id: `a-${a.id}`,
      date: a.dueAt as Date,
      title: a.title,
      href: a.dealId ? `/deals/${a.dealId}` : a.contactId ? `/contacts/${a.contactId}` : "/activities",
      color: TYPE_COLOR[a.type as ActivityType],
      kind: "activity",
      activityType: a.type as ActivityType,
      completed: !!a.completedAt,
    })),
    ...deals.map((d): CalEvent => ({
      id: `d-${d.id}`,
      date: d.closeDate as Date,
      title: `${d.title} (close)`,
      href: `/deals/${d.id}`,
      color: DEAL_COLOR,
      kind: "deal",
    })),
  ];

  const days = eachDayOfInterval({ start: gridStart, end: gridEnd });
  const eventsOn = (day: Date) => events.filter((e) => isSameDay(e.date, day));
  const agenda = events
    .filter((e) => isSameMonth(e.date, anchor))
    .sort((a, b) => a.date.getTime() - b.date.getTime());

  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <>
      <PageHeader title="Calendar" description="Activities and deal close dates by month.">
        <MonthNav month={monthStr} />
      </PageHeader>
      <div className="grid gap-6 p-6 lg:grid-cols-3">
        <section className="lg:col-span-2">
          <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border bg-border text-xs">
            {weekdays.map((w) => (
              <div key={w} className="bg-card p-2 text-center font-medium text-muted-foreground">
                {w}
              </div>
            ))}
            {days.map((day) => {
              const dayEvents = eventsOn(day);
              const inMonth = isSameMonth(day, anchor);
              return (
                <div
                  key={day.toISOString()}
                  className={cn(
                    "min-h-24 bg-card p-1.5",
                    !inMonth && "bg-muted/30 text-muted-foreground",
                  )}
                >
                  <div
                    className={cn(
                      "mb-1 inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px]",
                      isToday(day) && "bg-primary font-semibold text-primary-foreground",
                    )}
                  >
                    {format(day, "d")}
                  </div>
                  <div className="space-y-1">
                    {dayEvents.slice(0, 3).map((e) => (
                      <Link
                        key={e.id}
                        href={e.href}
                        className="flex items-center gap-1 truncate rounded px-1 py-0.5 hover:bg-accent"
                      >
                        <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", e.color)} />
                        <span className={cn("truncate", e.completed && "text-muted-foreground line-through")}>
                          {e.title}
                        </span>
                      </Link>
                    ))}
                    {dayEvents.length > 3 && (
                      <p className="px-1 text-[10px] text-muted-foreground">+{dayEvents.length - 3} more</p>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
        <aside>
          <div className="rounded-lg border bg-card p-4">
            <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
              Agenda · {format(anchor, "MMMM")}
            </h2>
            {agenda.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nothing scheduled this month.</p>
            ) : (
              <ul className="space-y-2">
                {agenda.map((e) => (
                  <li key={e.id} className="flex items-center gap-2 text-sm">
                    {e.kind === "activity" ? (
                      <CompleteToggle id={e.id.slice(2)} completed={!!e.completed} />
                    ) : (
                      <span className={cn("h-2.5 w-2.5 shrink-0 rounded-full", e.color)} />
                    )}
                    <span className="w-10 shrink-0 text-xs text-muted-foreground">{format(e.date, "MMM d")}</span>
                    <Link
                      href={e.href}
                      className={cn("flex-1 truncate hover:underline", e.completed && "text-muted-foreground line-through")}
                    >
                      {e.title}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>
      </div>
    </>
  );
}
