"use client";
import { useMemo, useState } from "react";
import { GitBranch } from "lucide-react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Position,
  type Node,
  type Edge,
} from "@xyflow/react";
import dagre from "@dagrejs/dagre";
import "@xyflow/react/dist/style.css";
import type { GraphDTO } from "@/shared/contracts";
import { TaskStatus } from "./tasks";
import { useLocale } from "./locale";
import { Button } from "@/components/ui";

export function DependencyGraph({
  graph,
  onOpen,
}: {
  graph: GraphDTO | null;
  onOpen: (id: string) => void;
}) {
  const { t } = useLocale();
  const [textView, setTextView] = useState(false);
  const nodes: Node[] = useMemo(() => {
    const layout = new dagre.graphlib.Graph();
    layout.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 100 });
    layout.setDefaultEdgeLabel(() => ({}));
    for (const task of graph?.nodes ?? [])
      layout.setNode(task.task_id, { width: 210, height: 100 });
    const ids = new Set(graph?.nodes.map((task) => task.task_id) ?? []);
    for (const edge of graph?.edges ?? [])
      if (ids.has(edge.prerequisite_task_id) && ids.has(edge.dependent_task_id))
        layout.setEdge(edge.prerequisite_task_id, edge.dependent_task_id);
    dagre.layout(layout);
    return (graph?.nodes ?? []).map((task) => ({
      id: task.task_id,
      position: {
        x: layout.node(task.task_id).x - 105,
        y: layout.node(task.task_id).y - 50,
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      data: {
        label: (
          <div className="graph-label">
            <span>{task.title}</span>
            <TaskStatus task={task} />
          </div>
        ),
      },
      style: {
        background: "var(--surface)",
        color: "var(--ink)",
        border: "1px solid var(--line)",
        borderRadius: 12,
        width: 210,
      },
    }));
  }, [graph]);
  const edges: Edge[] = (graph?.edges ?? []).map((edge) => ({
    id: edge.edge_id,
    source: edge.prerequisite_task_id,
    target: edge.dependent_task_id,
    label: edge.operator,
    animated: false,
    style: {
      stroke: edge.mode === "soft" ? "#838a9b" : "#a8a4ff",
      strokeDasharray: edge.mode === "soft" ? "5 5" : undefined,
    },
    markerEnd: { type: "arrowclosed" as const, color: "#a8a4ff" },
  }));
  return (
    <div className="graph-section">
      <div className="section-heading">
        <p>
          {t(
            "جهت فلش: پیش‌نیاز ← کار وابسته",
            "Arrow direction: prerequisite → dependent",
          )}
        </p>
        <Button onClick={() => setTextView((value) => !value)}>
          {textView
            ? t("نمای گراف", "Graph view")
            : t("نمای متنی قابل دسترس", "Accessible text view")}
        </Button>
      </div>
      {graph && (
        <p className="small muted">
          {t(
            `نمایش ${graph.nodes.length} از ${graph.total} کار در این محدوده`,
            `Showing ${graph.nodes.length} of ${graph.total} tasks in this scope`,
          )}
        </p>
      )}
      {graph &&
        (graph.truncated ||
          graph.next_cursor ||
          (graph.hidden_neighbor_count ?? 0) > 0) && (
          <div className="blocker-banner graph-boundary" role="note">
            <GitBranch size={18} />
            <div>
              <strong>
                {t(
                  "این نما همهٔ روابط را نشان نمی‌دهد",
                  "This view does not contain every dependency",
                )}
              </strong>
              <p>
                {t(
                  `${graph.hidden_neighbor_count ?? 0} کار مرتبط بیرون از این صفحه است. برای دیدن زمینهٔ کامل، یک کار محوری انتخاب کن یا بخش بعدی گراف را باز کن. وضعیت آمادگی از دادهٔ کامل سرور محاسبه می‌شود.`,
                  `${graph.hidden_neighbor_count ?? 0} connected tasks are outside this page. Select a focus task or open the next graph page for context. Readiness is computed from the complete server state.`,
                )}
              </p>
              {!!graph.boundary_edges?.length && (
                <details>
                  <summary>
                    {t("روابط بیرون از صفحه", "Connections outside this page")}{" "}
                    · {graph.boundary_edges.length}
                  </summary>
                  {graph.boundary_edges.map((edge) => (
                    <div className="dependency-row" key={edge.edge_id}>
                      <button onClick={() => onOpen(edge.prerequisite_task_id)}>
                        {edge.title ||
                          graph.nodes.find(
                            (task) =>
                              task.task_id === edge.prerequisite_task_id,
                          )?.title ||
                          t(
                            "پیش‌نیاز بیرون صفحه",
                            "Prerequisite outside this page",
                          )}
                      </button>
                      <span>
                        → {edge.operator} · {edge.mode}
                      </span>
                      <button onClick={() => onOpen(edge.dependent_task_id)}>
                        {graph.nodes.find(
                          (task) => task.task_id === edge.dependent_task_id,
                        )?.title ||
                          t(
                            "کار وابسته بیرون صفحه",
                            "Dependent task outside this page",
                          )}
                      </button>
                    </div>
                  ))}
                  {graph.boundary_edges_truncated && (
                    <p>
                      {t(
                        "فهرست روابط نیز به ۱۰۰۰ مورد محدود شده؛ محدوده را کوچک‌تر کن.",
                        "Connections are also limited to 1,000. Narrow the scope.",
                      )}
                    </p>
                  )}
                </details>
              )}
            </div>
          </div>
        )}
      {textView ? (
        <div className="task-list">
          {graph?.nodes.map((task) => (
            <div className="linear-graph-row" key={task.task_id}>
              <button onClick={() => onOpen(task.task_id)}>{task.title}</button>
              <TaskStatus task={task} />
              <div>
                {task.prerequisites.map((edge) => (
                  <button
                    className="chip"
                    key={edge.edge_id}
                    onClick={() => onOpen(edge.prerequisite_task_id)}
                  >
                    {edge.operator} · {edge.title} · {edge.mode}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="graph-canvas" dir="ltr">
          <ReactFlow
            key={(graph?.nodes ?? []).map((task) => task.task_id).join(":")}
            nodes={nodes}
            edges={edges}
            onNodeClick={(_, node) => onOpen(node.id)}
            fitView
            minZoom={0.2}
          >
            <Background color="#363a45" />
            <Controls />
            <MiniMap
              nodeColor="var(--accent-strong)"
              maskColor="#15171c99"
              pannable
              zoomable
            />
          </ReactFlow>
        </div>
      )}
    </div>
  );
}
