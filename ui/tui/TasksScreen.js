import React, { useEffect, useMemo, useState } from "react";
import htm from "htm";
import * as ink from "ink";
import { getFooterHints } from "./HelpScreen.js";

const Box = ink.Box ?? ink.default?.Box;
const Text = ink.Text ?? ink.default?.Text;
const useInput = ink.useInput ?? ink.default?.useInput;
const useStdout = ink.useStdout ?? ink.default?.useStdout;

import {
  buildBoardColumns,
  buildFormStateFromTask,
  buildListRows,
  createTaskApiFromRequestJson,
  createTaskFromForm,
  deleteTaskById,
  EMPTY_TASK_FORM,
  formatColumnSummary,
  LINE_LIST_FIELD_KEYS,
  listTasksFromApi,
  PRIORITY_COLOR_MAP,
  PRIORITY_OPTIONS,
  resolveTaskView,
  STATUS_OPTIONS,
  truncateText,
  updateTaskFromForm,
  validateTaskForm,
} from "./tasks-screen-helpers.js";

const html = htm.bind(React.createElement);
const FORM_FIELDS = [
  { key: "title", label: "Title", multiline: false },
  { key: "priority", label: "Priority", select: PRIORITY_OPTIONS },
  { key: "status", label: "Status", select: STATUS_OPTIONS },
  { key: "tagsText", label: "Tags", multiline: false },
  { key: "description", label: "Description", multiline: true },
  { key: "stepsText", label: "Steps", multiline: true },
  { key: "acceptanceCriteriaText", label: "AC", multiline: true },
  { key: "verificationText", label: "Verify", multiline: true },
];
const STATUS_MOVE_ORDER = ["todo", "in_progress", "review", "done"];

function clamp(value, min, max) {
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

function cycleOption(options, current, direction) {
  const values = Array.isArray(options) ? options : [];
  if (!values.length) return current;
  const index = Math.max(0, values.indexOf(current));
  const nextIndex = (index + direction + values.length) % values.length;
  return values[nextIndex] || values[0] || current;
}

function appendInput(value, input) {
  return `${String(value || "")}${input}`;
}

function removeLastCharacter(value) {
  return String(value || "").slice(0, -1);
}

function getSelectionFromColumns(columns, selection) {
  const column = columns[selection.columnIndex] || columns[0];
  const item = column?.items?.[selection.rowIndex] || null;
  return { column, item };
}

function formatFormValue(field, value, active) {
  const rendered = String(value || "");
  if (field.select) {
    const label = rendered || "(select)";
    return active ? `< ${label} >` : label;
  }
  if (!rendered) return active ? "█" : "(empty)";
  return active ? `${rendered}█` : rendered;
}

function buildFieldHint(field) {
  if (field.select) return "←/→ to cycle";
  if (LINE_LIST_FIELD_KEYS.has(field.key)) return "Enter adds line";
  if (field.multiline) return "Enter adds newline";
  return "Type to edit";
}

function TaskCard({ task, selected, width }) {
  const tagText = (task.tags || []).slice(0, 3).map((tag) => `[${tag}]`).join(" ");
  return html`
    <${Box} flexDirection="column" borderStyle="single" paddingX=${1} marginBottom=${1}>
      <${Box}>
        <${Text} color=${PRIORITY_COLOR_MAP[task.priority] || task.priorityColor}>●<//>
        <${Text} inverse=${selected}> ${task.idShort}<//>
        <${Text} dimColor inverse=${selected}> ${truncateText(task.title || "Untitled", Math.max(8, width - 12))}<//>
      <//>
      ${tagText
        ? html`<${Text} color="cyan" inverse=${selected}>${truncateText(tagText, Math.max(8, width - 4))}<//>`
        : html`<${Text} dimColor inverse=${selected}>No tags<//>`}
    <//>
  `;
}

function FormField({ field, active, value, error }) {
  return html`
    <${Box} flexDirection="column" marginBottom=${1}>
      <${Text} bold=${active}>${field.label}${error ? ` - ${error}` : ""}<//>
      <${Box} borderStyle="single" paddingX=${1}>
        <${Text} color=${error ? "red" : undefined}>${formatFormValue(field, value, active)}<//>
      <//>
      <${Text} dimColor>${buildFieldHint(field)}<//>
    <//>
  `;
}

function TaskForm({ mode, formState, activeFieldIndex, validationErrors, busy }) {
  return html`
    <${Box} marginTop=${1} flexDirection="column" borderStyle="double" paddingX=${1}>
      <${Text} bold>${mode === "create" ? "New Task" : "Edit Task"}<//>
      ${FORM_FIELDS.map((field, index) => html`
        <${FormField}
          key=${field.key}
          field=${field}
          active=${index === activeFieldIndex}
          value=${formState[field.key] || ""}
          error=${validationErrors[field.key]}
        />
      `)}
      <${Text} dimColor>
        [Tab] Next  [Shift+Tab] Prev  [Left/Right] Select  [Ctrl+S] Save  [Esc] Cancel
      <//>
      ${busy ? html`<${Text} color="yellow">Saving...<//>` : null}
    <//>
  `;
}

export default function TasksScreen({
  tasks = [],
  requestJson,
  onTasksChange,
  onInputCaptureChange,
  onFooterHintsChange,
}) {
  const { stdout } = useStdout();
  const terminalWidth = stdout?.columns || process.stdout.columns || 120;
  const [preferredView, setPreferredView] = useState("kanban");
  const [selection, setSelection] = useState({ columnIndex: 0, rowIndex: 0, listIndex: 0 });
  const [filterOpen, setFilterOpen] = useState(false);
  const [filterText, setFilterText] = useState("");
  const [formMode, setFormMode] = useState(null);
  const [formState, setFormState] = useState(EMPTY_TASK_FORM);
  const [activeFieldIndex, setActiveFieldIndex] = useState(0);
  const [validationErrors, setValidationErrors] = useState({});
  const [deletePrompt, setDeletePrompt] = useState(false);
  const [statusLine, setStatusLine] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState(null);
  const taskApi = useMemo(() => createTaskApiFromRequestJson(requestJson), [requestJson]);

  const viewMode = resolveTaskView(terminalWidth, preferredView);
  const columnWidth = Math.max(24, Math.floor((terminalWidth - 10) / 4));
  const columns = useMemo(
    () => buildBoardColumns(tasks, { filterText, columnWidth }),
    [tasks, filterText, columnWidth],
  );
  const listRows = useMemo(
    () => buildListRows(tasks, { filterText, rowWidth: Math.max(40, terminalWidth - 8) }),
    [tasks, filterText, terminalWidth],
  );
  const columnSummary = useMemo(() => formatColumnSummary(columns), [columns]);

  useEffect(() => {
    const locked = filterOpen || Boolean(formMode) || deletePrompt || busy;
    if (typeof onInputCaptureChange === "function") {
      onInputCaptureChange(locked);
    }
    return () => {
      if (typeof onInputCaptureChange === "function") {
        onInputCaptureChange(false);
      }
    };
  }, [busy, deletePrompt, filterOpen, formMode, onInputCaptureChange]);

  useEffect(() => {
    if (typeof onFooterHintsChange !== "function") return;
    onFooterHintsChange(getFooterHints("tasks", {
      deletePrompt,
      filterOpen,
      formMode: Boolean(formMode),
    }));
  }, [deletePrompt, filterOpen, formMode, onFooterHintsChange]);

  useEffect(() => {
    if (viewMode === "kanban") {
      setSelection((current) => {
        const columnIndex = clamp(current.columnIndex, 0, columns.length - 1);
        const rowIndex = clamp(current.rowIndex, 0, Math.max(0, (columns[columnIndex]?.items?.length || 1) - 1));
        return { ...current, columnIndex, rowIndex };
      });
      return;
    }

    setSelection((current) => ({
      ...current,
      listIndex: clamp(current.listIndex, 0, Math.max(0, listRows.length - 1)),
    }));
  }, [columns, listRows, viewMode]);

  const selectedTask = useMemo(() => {
    if (viewMode === "kanban") {
      return getSelectionFromColumns(columns, selection).item;
    }
    return listRows[selection.listIndex] || null;
  }, [columns, listRows, selection, viewMode]);

  async function refreshTasks(message = "") {
    const nextTasks = await listTasksFromApi({}, taskApi);
    if (typeof onTasksChange === "function") {
      onTasksChange(nextTasks);
    }
    if (message) setStatusLine(message);
  }

  function openCreateForm() {
    setFormMode("create");
    setEditingTaskId(null);
    setFormState({ ...EMPTY_TASK_FORM, status: selectedTask?.statusDisplay || "todo" });
    setActiveFieldIndex(0);
    setValidationErrors({});
    setDeletePrompt(false);
    setStatusLine("");
  }

  function openEditForm(task) {
    if (!task) return;
    setFormMode("edit");
    setEditingTaskId(task.id);
    setFormState(buildFormStateFromTask(task));
    setActiveFieldIndex(0);
    setValidationErrors({});
    setDeletePrompt(false);
    setStatusLine("");
  }

  function closeForm() {
    setFormMode(null);
    setEditingTaskId(null);
    setValidationErrors({});
    setBusy(false);
  }

  async function submitForm() {
    const errors = validateTaskForm(formState);
    setValidationErrors(errors);
    if (Object.keys(errors).length) return;

    setBusy(true);
    try {
      if (formMode === "create") {
        const created = await createTaskFromForm(formState, taskApi);
        await refreshTasks(`Created ${created.id || "task"}`);
      } else if (editingTaskId) {
        const updated = await updateTaskFromForm(editingTaskId, formState, taskApi);
        await refreshTasks(`Updated ${updated.id || editingTaskId}`);
      }
      closeForm();
    } catch (error) {
      setValidationErrors(error?.validationErrors || {});
      setStatusLine(String(error?.message || error || "Task save failed"));
      setBusy(false);
    }
  }

  async function confirmDeleteTask() {
    if (!selectedTask) return;
    setBusy(true);
    try {
      await deleteTaskById(selectedTask.id, taskApi);
      setDeletePrompt(false);
      await refreshTasks(`Deleted ${selectedTask.idShort}`);
    } catch (error) {
      setStatusLine(String(error?.message || error || "Delete failed"));
    } finally {
      setBusy(false);
    }
  }

  async function moveSelectedTask(direction) {
    if (!selectedTask || busy) return;
    const currentIndex = STATUS_MOVE_ORDER.indexOf(selectedTask.statusDisplay || "todo");
    const nextIndex = clamp(currentIndex + direction, 0, STATUS_MOVE_ORDER.length - 1);
    if (nextIndex === currentIndex) return;

    setBusy(true);
    try {
      const nextStatus = STATUS_MOVE_ORDER[nextIndex];
      await updateTaskFromForm(selectedTask.id, {
        ...buildFormStateFromTask(selectedTask),
        status: nextStatus,
      }, taskApi);
      await refreshTasks(`Moved ${selectedTask.idShort} to ${nextStatus.replace("_", " ")}`);
    } catch (error) {
      setStatusLine(String(error?.message || error || "Status change failed"));
    } finally {
      setBusy(false);
    }
  }

  useInput((input, key) => {
    if (busy) return;

    if (deletePrompt) {
      if (input === "y" || input === "Y") {
        void confirmDeleteTask();
        return;
      }
      if (key.escape || input === "n" || input === "N") {
        setDeletePrompt(false);
      }
      return;
    }

    if (formMode) {
      const field = FORM_FIELDS[activeFieldIndex];
      if (!field) return;

      if (key.escape) {
        closeForm();
        return;
      }
      if (key.ctrl && input === "s") {
        void submitForm();
        return;
      }
      if (key.tab && key.shift) {
        setActiveFieldIndex((current) => clamp(current - 1, 0, FORM_FIELDS.length - 1));
        return;
      }
      if (key.tab || key.downArrow) {
        setActiveFieldIndex((current) => clamp(current + 1, 0, FORM_FIELDS.length - 1));
        return;
      }
      if (key.upArrow) {
        setActiveFieldIndex((current) => clamp(current - 1, 0, FORM_FIELDS.length - 1));
        return;
      }
      if (field.select) {
        if (key.leftArrow) {
          setFormState((current) => ({
            ...current,
            [field.key]: cycleOption(field.select, current[field.key], -1),
          }));
          return;
        }
        if (key.rightArrow || key.return) {
          setFormState((current) => ({
            ...current,
            [field.key]: cycleOption(field.select, current[field.key], 1),
          }));
          return;
        }
      }
      if (key.backspace || key.delete) {
        setFormState((current) => ({
          ...current,
          [field.key]: removeLastCharacter(current[field.key]),
        }));
        return;
      }
      if (key.return) {
        if (field.multiline) {
          setFormState((current) => ({
            ...current,
            [field.key]: appendInput(current[field.key], "\n"),
          }));
        } else {
          setActiveFieldIndex((current) => clamp(current + 1, 0, FORM_FIELDS.length - 1));
        }
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setFormState((current) => ({
          ...current,
          [field.key]: appendInput(current[field.key], input),
        }));
        if (field.key === "title" && validationErrors.title) {
          setValidationErrors({});
        }
      }
      return;
    }

    if (filterOpen) {
      if (key.escape) {
        setFilterText("");
        setFilterOpen(false);
        return;
      }
      if (key.backspace || key.delete) {
        setFilterText((current) => current.slice(0, -1));
        return;
      }
      if (key.return) {
        setFilterOpen(false);
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setFilterText((current) => `${current}${input}`);
      }
      return;
    }

    if (input === "n" || input === "N") {
      openCreateForm();
      return;
    }
    if (input === "e" || input === "E" || key.return) {
      openEditForm(selectedTask);
      return;
    }
    if (input === "d" || input === "D") {
      if (selectedTask) setDeletePrompt(true);
      return;
    }
    if (input === "f" || input === "F") {
      setFilterOpen(true);
      return;
    }
    if (input === "v" || input === "V") {
      setPreferredView((current) => (current === "kanban" ? "list" : "kanban"));
      return;
    }
    if (input === "[") {
      void moveSelectedTask(-1);
      return;
    }
    if (input === "]") {
      void moveSelectedTask(1);
      return;
    }

    if (viewMode === "kanban") {
      if (key.leftArrow) {
        setSelection((current) => {
          const columnIndex = clamp(current.columnIndex - 1, 0, columns.length - 1);
          const rowIndex = clamp(current.rowIndex, 0, Math.max(0, (columns[columnIndex]?.items?.length || 1) - 1));
          return { ...current, columnIndex, rowIndex };
        });
        return;
      }
      if (key.rightArrow) {
        setSelection((current) => {
          const columnIndex = clamp(current.columnIndex + 1, 0, columns.length - 1);
          const rowIndex = clamp(current.rowIndex, 0, Math.max(0, (columns[columnIndex]?.items?.length || 1) - 1));
          return { ...current, columnIndex, rowIndex };
        });
        return;
      }
      if (key.upArrow) {
        setSelection((current) => ({ ...current, rowIndex: Math.max(0, current.rowIndex - 1) }));
        return;
      }
      if (key.downArrow) {
        setSelection((current) => {
          const maxRow = Math.max(0, (columns[current.columnIndex]?.items?.length || 1) - 1);
          return { ...current, rowIndex: clamp(current.rowIndex + 1, 0, maxRow) };
        });
      }
      return;
    }

    if (key.upArrow) {
      setSelection((current) => ({ ...current, listIndex: Math.max(0, current.listIndex - 1) }));
      return;
    }
    if (key.downArrow) {
      setSelection((current) => ({
        ...current,
        listIndex: clamp(current.listIndex + 1, 0, Math.max(0, listRows.length - 1)),
      }));
    }
  });

  return html`
    <${Box} flexDirection="column" paddingY=${1}>
      <${Box} justifyContent="space-between" paddingX=${1}>
        <${Text} bold>Tasks<//>
        <${Text} dimColor>[V]iew: kanban/list -> ${viewMode}${terminalWidth < 140 ? " (auto)" : ""}<//>
      <//>

      <${Box} paddingX=${1} marginTop=${1}>
        <${Text} dimColor>${columnSummary}<//>
      <//>

      <${Box} paddingX=${1} marginTop=${1}>
        <${Text} color=${filterOpen ? "cyan" : undefined}>
          [F]ilter: ${filterText || "(title, tag, id)"}${filterOpen ? "█" : ""}
        <//>
      <//>

      ${formMode
        ? html`
            <${TaskForm}
              mode=${formMode}
              formState=${formState}
              activeFieldIndex=${activeFieldIndex}
              validationErrors=${validationErrors}
              busy=${busy}
            />
          `
        : null}

      ${deletePrompt && selectedTask
        ? html`
            <${Box} marginTop=${1} paddingX=${1}>
              <${Text} color="red">Delete ${selectedTask.idShort}? [y/N]<//>
            <//>
          `
        : null}

      ${viewMode === "kanban"
        ? html`
            <${Box} marginTop=${1}>
              ${columns.map((column, columnIndex) => html`
                <${Box}
                  key=${column.key}
                  flexDirection="column"
                  flexGrow=${1}
                  width=${columnWidth}
                  marginRight=${columnIndex < columns.length - 1 ? 1 : 0}
                  borderStyle="round"
                  paddingX=${1}
                >
                  <${Text} bold inverse=${selection.columnIndex === columnIndex}>${column.label} (${column.count})<//>
                  ${column.items.length
                    ? column.items.map((task, rowIndex) => html`
                        <${TaskCard}
                          key=${task.id}
                          task=${task}
                          selected=${selection.columnIndex === columnIndex && selection.rowIndex === rowIndex}
                          width=${columnWidth - 4}
                        />
                      `)
                    : html`<${Text} dimColor>No tasks<//>`}
                <//>
              `)}
            <//>
          `
        : html`
            <${Box} marginTop=${1} flexDirection="column" borderStyle="round" paddingX=${1}>
              <${Text} bold>Task List<//>
              ${listRows.length
                ? listRows.map((task, index) => html`
                    <${Box} key=${task.id} marginTop=${1}>
                      <${Text} inverse=${selection.listIndex === index}>${task.statusDisplay.padEnd(11)}<//>
                      <${Text} color=${PRIORITY_COLOR_MAP[task.priority] || task.priorityColor}> ● <//>
                      <${Text} inverse=${selection.listIndex === index}>${task.idShort} ${task.truncatedTitle}<//>
                      <${Text} color="cyan" dimColor=${!(task.tags || []).length}> ${(task.tags || []).map((tag) => `[${tag}]`).join(" ") || "No tags"}<//>
                    <//>
                  `)
                : html`<${Text} dimColor>No matching tasks<//>`}
            <//>
          `}

      <${Box} marginTop=${1} paddingX=${1} borderStyle="single">
        <${Text} dimColor>
          [Arrows] Navigate  [Enter] Edit  [N] New  [E] Edit  [D] Delete  [F] Filter  [V] View  [[]/[]] Move
        <//>
      <//>
      ${selectedTask
        ? html`
            <${Box} marginTop=${1} paddingX=${1} flexDirection="column" borderStyle="single">
              <${Text} bold>${selectedTask.idShort} - ${selectedTask.title || "Untitled"}<//>
              <${Text} dimColor>${truncateText(selectedTask.description || "No description", Math.max(32, terminalWidth - 8))}<//>
            <//>
          `
        : null}
      ${statusLine
        ? html`
            <${Box} marginTop=${1} paddingX=${1}>
              <${Text} color="yellow">${statusLine}<//>
            <//>
          `
        : null}
    <//>
  `;
}
