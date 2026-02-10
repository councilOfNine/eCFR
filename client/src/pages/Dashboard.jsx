import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useAppStore } from "@/store/useAppStore";
import {
  Building2,
  FileText,
  Hash,
  Download,
  Loader2,
  CheckCircle2,
  AlertCircle,
  ArrowRight,
  BarChart3,
  RefreshCw,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
} from "lucide-react";

function formatNumber(n) {
  if (!n) return "0";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
  return n.toLocaleString();
}

function StatCard({ icon: Icon, label, value, sub, className }) {
  return (
    <div className={cn("rounded-xl border bg-card p-6 shadow-sm", className)}>
      <div className="flex items-center gap-3">
        <div className="rounded-lg bg-primary/10 p-2">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <div>
          <p className="text-sm text-muted-foreground">{label}</p>
          <p className="text-2xl font-bold">{value}</p>
          {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
        </div>
      </div>
    </div>
  );
}

function IngestPanel({ status, onQuickIngest, onFullIngest, isLoading }) {
  const isRunning = status?.status === "running";
  const pct = status?.total > 0 ? Math.round((status.progress / status.total) * 100) : 0;

  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm">
      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <Download className="h-5 w-5" /> Data Ingestion
      </h2>
      {isRunning ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>{status.message || "Processing..."}</span>
          </div>
          <div className="w-full bg-secondary rounded-full h-2">
            <div className="bg-primary h-2 rounded-full transition-all" style={{ width: `${pct}%` }} />
          </div>
          <p className="text-xs text-muted-foreground">
            {status.progress} / {status.total} titles ({pct}%)
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {status?.status === "completed" && (
            <p className="text-sm text-green-600 dark:text-green-400 flex items-center gap-1.5">
              <CheckCircle2 className="h-4 w-4" /> Last completed:{" "}
              {status.completed_at ? new Date(status.completed_at).toLocaleString() : "N/A"}
            </p>
          )}
          {status?.status === "error" && (
            <p className="text-sm text-red-600 dark:text-red-400 flex items-center gap-1.5">
              <AlertCircle className="h-4 w-4" /> {status.message}
            </p>
          )}
          <div className="flex gap-2">
            <button
              onClick={onQuickIngest}
              disabled={isLoading}
              className="inline-flex items-center gap-2 rounded-lg bg-secondary px-4 py-2 text-sm font-medium hover:bg-secondary/80 transition-colors disabled:opacity-50"
            >
              <RefreshCw className="h-4 w-4" /> Quick Sync (Agencies)
            </button>
            <button
              onClick={onFullIngest}
              disabled={isLoading}
              className="inline-flex items-center gap-2 rounded-lg bg-primary text-primary-foreground px-4 py-2 text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50"
            >
              <Download className="h-4 w-4" /> Full Ingest (+ Word Counts)
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Full ingest downloads all 50 CFR titles and computes word counts per agency. This may take several minutes.
          </p>
        </div>
      )}
    </div>
  );
}

const COLUMNS = [
  { key: "name", label: "Agency", align: "left" },
  { key: "word_count", label: "Word Count", align: "right" },
  { key: "total_word_count", label: "Total (w/ Sub)", align: "right" },
  { key: "children_count", label: "Sub-Agencies", align: "right" },
  { key: "cfr_refs_count", label: "CFR Refs", align: "right" },
];

function SortIcon({ column, sortKey, sortDir }) {
  if (sortKey !== column) return <ChevronsUpDown className="h-3.5 w-3.5 opacity-40" />;
  return sortDir === "asc" ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />;
}

function AgencyTable({ agencies }) {
  const [sortKey, setSortKey] = useState("total_word_count");
  const [sortDir, setSortDir] = useState("desc");

  const sorted = useMemo(() => {
    if (!agencies || agencies.length === 0) return [];
    return [...agencies].sort((a, b) => {
      let av = a[sortKey];
      let bv = b[sortKey];
      if (typeof av === "string") av = av.toLowerCase();
      if (typeof bv === "string") bv = bv.toLowerCase();
      if (av < bv) return sortDir === "asc" ? -1 : 1;
      if (av > bv) return sortDir === "asc" ? 1 : -1;
      return 0;
    });
  }, [agencies, sortKey, sortDir]);

  function handleSort(key) {
    if (sortKey === key) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  }

  if (!agencies || agencies.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Building2 className="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p>No agency data yet. Run an ingest to get started.</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            {COLUMNS.map((col) => (
              <th
                key={col.key}
                className={cn(
                  "pb-3 pr-4 font-semibold cursor-pointer select-none hover:text-foreground transition-colors",
                  col.align === "right" && "text-right",
                )}
                onClick={() => handleSort(col.key)}
              >
                <span className="inline-flex items-center gap-1">
                  {col.align === "right" && <SortIcon column={col.key} sortKey={sortKey} sortDir={sortDir} />}
                  {col.label}
                  {col.align === "left" && <SortIcon column={col.key} sortKey={sortKey} sortDir={sortDir} />}
                </span>
              </th>
            ))}
            <th className="pb-3 font-semibold"></th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((a) => (
            <tr key={a.slug} className="border-b last:border-0 hover:bg-muted/50 transition-colors">
              <td className="py-3 pr-4">
                <Link to={`/agency/${a.slug}`} className="hover:underline font-medium">
                  {a.name}
                </Link>
                {a.short_name && <span className="ml-2 text-xs text-muted-foreground">({a.short_name})</span>}
              </td>
              <td className="py-3 pr-4 text-right tabular-nums">{formatNumber(a.word_count)}</td>
              <td className="py-3 pr-4 text-right tabular-nums font-medium">{formatNumber(a.total_word_count)}</td>
              <td className="py-3 pr-4 text-right">{a.children_count}</td>
              <td className="py-3 pr-4 text-right">{a.cfr_refs_count}</td>
              <td className="py-3 text-right">
                <Link to={`/agency/${a.slug}`} className="text-primary hover:text-primary/80">
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TopAgenciesChart({ topAgencies }) {
  if (!topAgencies || topAgencies.length === 0) return null;
  const max = topAgencies[0]?.total_word_count || 1;

  return (
    <div className="rounded-xl border bg-card p-6 shadow-sm">
      <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
        <BarChart3 className="h-5 w-5" /> Top Agencies by Word Count
      </h2>
      <div className="space-y-2">
        {topAgencies.map((a) => {
          const pct = Math.max((a.total_word_count / max) * 100, 1);
          return (
            <Link key={a.slug} to={`/agency/${a.slug}`} className="block group">
              <div className="flex items-center gap-3">
                <span className="w-16 text-xs text-right text-muted-foreground tabular-nums shrink-0">
                  {formatNumber(a.total_word_count)}
                </span>
                <div className="flex-1 bg-secondary rounded-full h-6 overflow-hidden">
                  <div
                    className="bg-primary/80 group-hover:bg-primary h-6 rounded-full transition-all flex items-center px-2"
                    style={{ width: `${pct}%`, minWidth: "60px" }}
                  >
                    <span className="text-xs text-primary-foreground font-medium truncate">
                      {a.short_name || a.name}
                    </span>
                  </div>
                </div>
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

export default function Dashboard() {
  const queryClient = useQueryClient();
  const setData = useAppStore((s) => s.setData);

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ["stats"],
    queryFn: api.getStats,
    refetchInterval: 5000,
  });

  const { data: wordcountData, isLoading: wordcountsLoading } = useQuery({
    queryKey: ["wordcounts"],
    queryFn: api.getWordCounts,
  });

  const quickIngest = useMutation({
    mutationFn: api.triggerQuickIngest,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stats"] });
      queryClient.invalidateQueries({ queryKey: ["wordcounts"] });
    },
  });

  const fullIngest = useMutation({
    mutationFn: api.triggerFullIngest,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stats"] });
    },
  });

  if (stats) setData(stats);

  const agencies = wordcountData?.wordcounts || [];
  const ingestStatus = stats?.ingest_status;

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card/50 backdrop-blur-sm sticky top-0 z-40">
        <div className="container mx-auto px-4 py-4">
          <h1 className="text-2xl font-bold tracking-tight">eCFR Regulation Analyzer</h1>
          <p className="text-sm text-muted-foreground">Analyze federal regulations across government agencies</p>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8 space-y-8">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <StatCard
            icon={Building2}
            label="Agencies"
            value={stats?.total_agencies || "—"}
            sub={`+ ${stats?.total_sub_agencies || 0} sub-agencies`}
          />
          <StatCard icon={FileText} label="CFR Titles" value={stats?.total_titles || "—"} />
          <StatCard
            icon={Hash}
            label="Total Words"
            value={formatNumber(stats?.total_word_count)}
            sub="across all agencies"
          />
          <StatCard
            icon={CheckCircle2}
            label="Last Updated"
            value={stats?.last_fetched ? new Date(stats.last_fetched).toLocaleDateString() : "Never"}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-1 space-y-6">
            <IngestPanel
              status={ingestStatus}
              onQuickIngest={() => quickIngest.mutate()}
              onFullIngest={() => fullIngest.mutate()}
              isLoading={quickIngest.isPending || fullIngest.isPending}
            />
            <TopAgenciesChart topAgencies={stats?.top_agencies} />
          </div>

          <div className="lg:col-span-2">
            <div className="rounded-xl border bg-card p-6 shadow-sm">
              <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
                <Building2 className="h-5 w-5" /> All Agencies
                <span className="text-sm font-normal text-muted-foreground ml-auto">{agencies.length} agencies</span>
              </h2>
              {wordcountsLoading ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <AgencyTable agencies={agencies} />
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
