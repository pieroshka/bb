import { useState } from "react";
import { useBbContext, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "../../components/empty-state.js";
import type { Task } from "../../shared/contract.js";
import { useProjects } from "../../shell/data.js";
import { PANEL_PATH, tasksRouteToSubPath } from "../../shell/routes.js";
import { BoardView } from "../board/index.js";

/**
 * The board of the Tasks project linked to the current bb project, for the
 * thread side panel. Cards open in a sibling side-panel tab so the thread
 * stays in view.
 */
export function ProjectBoardPanel() {
  const { projectId: bbProjectId } = useBbContext();
  const navigate = useBbNavigate();
  const projects = useProjects();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const openTasks = (subPath?: string) =>
    navigate.toPluginPanel(PANEL_PATH, subPath === undefined ? {} : { subPath });

  if (projects.data === undefined) {
    if (projects.error) {
      return (
        <EmptyState
          icon="AlertCircle"
          title="Couldn't load projects"
          action={
            <Button variant="outline" size="sm" onClick={projects.refresh}>
              Retry
            </Button>
          }
        />
      );
    }
    return <Skeleton className="h-24 w-full" />;
  }

  const linked = projects.data.filter(
    (project) =>
      bbProjectId !== null && project.linkedBbProjectId === bbProjectId,
  );
  const project =
    linked.find((candidate) => candidate.id === selectedId) ?? linked[0];
  if (project === undefined) {
    return (
      <EmptyState
        icon="ListTodo"
        title="No Tasks project for this project"
        description="Link a Tasks project to this bb project to see its board here."
        action={
          <Button variant="outline" size="sm" onClick={() => openTasks("manage")}>
            Manage projects
          </Button>
        }
      />
    );
  }

  const openTask = (task: Task) => {
    const opened = navigate.openThreadPanel({
      actionId: "task",
      title: task.key,
      params: { taskKey: task.key },
    });
    if (!opened) openTasks(tasksRouteToSubPath({ kind: "task", taskKey: task.key }));
  };
  const boardSubPath = tasksRouteToSubPath({
    kind: "project",
    projectId: project.id,
    view: "board",
  });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pb-2">
        {linked.length > 1 ? (
          <Select value={project.id} onValueChange={setSelectedId}>
            <SelectTrigger aria-label="Tasks project" className="h-8 min-w-0 flex-1">
              <SelectValue>{project.name}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {linked.map((candidate) => (
                <SelectItem key={candidate.id} value={candidate.id}>
                  {candidate.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <div className="min-w-0 flex-1 truncate text-sm font-medium">
            {project.name}
          </div>
        )}
        <Button
          className="size-8 shrink-0"
          size="icon"
          variant="ghost"
          aria-label={`Open ${project.name} board in Tasks`}
          onClick={() => openTasks(boardSubPath)}
        >
          <Icon name="ArrowUpRight" className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        <BoardView projectId={project.id} onOpenTask={openTask} />
      </div>
    </div>
  );
}
