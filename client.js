window.__ModuleLoader__.load({
  id: "dsh-plugin-todo-stack",
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    "use strict";
    var __defProp = Object.defineProperty;
    var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
    var __getOwnPropNames = Object.getOwnPropertyNames;
    var __hasOwnProp = Object.prototype.hasOwnProperty;
    var __export = (target, all) => {
      for (var name in all)
        __defProp(target, name, { get: all[name], enumerable: true });
    };
    var __copyProps = (to, from, except, desc) => {
      if (from && typeof from === "object" || typeof from === "function") {
        for (let key of __getOwnPropNames(from))
          if (!__hasOwnProp.call(to, key) && key !== except)
            __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
      }
      return to;
    };
    var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
    
    // client/index.ts
    var index_exports = {};
    __export(index_exports, {
      TodoStackDock: () => TodoStackDock,
      TodoStackPanel: () => TodoStackPanel,
      apply: () => apply,
      flattenTodoStack: () => flattenTodoStack,
      inject: () => inject
    });
    module.exports = __toCommonJS(index_exports);
    var import_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    var import_react = require("react");
    var PLUGIN_ID = "dsh-plugin-todo-stack";
    var NS = "todo-stack";
    var STYLE_ID = `${PLUGIN_ID}/TodoStackDock.css`;
    var zh = {
      title: "\u4EFB\u52A1\u6808",
      "focus.current": "\u5F53\u524D\uFF1A{content}",
      "progress.pending": "{count} \u5F85\u5904\u7406",
      "progress.completed": "{count} \u5DF2\u5B8C\u6210",
      "progress.dropped": "{count} \u5DF2\u653E\u5F03",
      "status.focused": "\u5F53\u524D\u4EFB\u52A1",
      "status.pending": "\u5F85\u5904\u7406",
      "status.completed": "\u5DF2\u5B8C\u6210",
      "status.dropped": "\u5DF2\u653E\u5F03"
    };
    var en = {
      title: "Task Stack",
      "focus.current": "Current: {content}",
      "progress.pending": "{count} pending",
      "progress.completed": "{count} completed",
      "progress.dropped": "{count} dropped",
      "status.focused": "Current task",
      "status.pending": "Pending",
      "status.completed": "Completed",
      "status.dropped": "Dropped"
    };
    var css = `
    .todoStackRoot{box-sizing:border-box;width:calc(100% - var(--dsh-composer-side-clearance) - var(--dsh-composer-side-clearance) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));max-width:calc(var(--dsh-composer-card-max-width) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset) - var(--dsh-composer-dock-inset));border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-specific-tip);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2);border-radius:12px;flex:none;margin:0 auto;overflow:hidden}
    .todoStackBody{display:flex;flex-direction:column;padding:6px 8px}
    .todoStackHeader{display:flex;align-items:center;gap:10px;width:100%;padding:0 4px;color:inherit;text-align:left;cursor:pointer;background:transparent;border:0;border-radius:7px}
    .todoStackHeader:focus-visible{outline:2px solid var(--dsw-alias-label-tertiary);outline-offset:-2px}
    .todoStackLead,.todoStackChevron{display:grid;place-items:center;color:var(--dsw-alias-label-tertiary);flex:none}
    .todoStackTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:24px;flex:none}
    .todoStackProgress{min-width:0;color:var(--dsw-alias-label-tertiary);font-size:13px;font-weight:400;line-height:20px;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;flex:auto}
    .todoStackList{display:flex;flex-direction:column;gap:2px;max-height:240px;margin:4px 0 0;padding:0;list-style:none;overflow-y:auto}
    .todoStackRow{--todo-indent:0px;box-sizing:border-box;position:relative;display:flex;align-items:center;min-width:0;min-height:28px;padding:3px 8px 3px calc(4px + var(--todo-indent));border-radius:7px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}
    .todoStackRow[data-focused="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
    .todoStackBranch{box-sizing:border-box;width:11px;height:14px;margin:-7px 5px 0 0;border-inline-start:1px solid var(--dsw-alias-border-l2);border-bottom:1px solid var(--dsw-alias-border-l2);border-end-start-radius:4px;flex:none}
    .todoStackGlyph{display:grid;place-items:center;width:16px;height:16px;margin-inline-end:8px;color:var(--dsw-alias-label-caption);flex:none}
    .todoStackGlyph[data-status="focused"]{color:var(--dsw-alias-state-business-primary);animation:1s linear infinite todo-stack-spin}
    .todoStackGlyph[data-status="completed"]{color:var(--dsw-alias-state-success-primary)}
    .todoStackGlyph[data-status="dropped"]{color:var(--dsw-alias-label-caption)}
    .todoStackContent{min-width:0;text-overflow:ellipsis;white-space:nowrap;overflow:hidden;flex:auto}
    .todoStackRow[data-status="completed"] .todoStackContent,.todoStackRow[data-status="dropped"] .todoStackContent{color:var(--dsw-alias-label-tertiary)}
    .todoStackRow[data-status="dropped"] .todoStackContent{text-decoration:line-through}
    .todoStackCurrent{margin-inline-start:8px;padding:0 6px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 12%,transparent);color:var(--dsw-alias-state-business-primary);font-size:11px;line-height:18px;flex:none}
    @keyframes todo-stack-spin{to{transform:rotate(360deg)}}
    `;
    if (typeof document !== "undefined" && document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) === null) {
      const tag = document.createElement("style");
      tag.dataset.plugin = PLUGIN_ID;
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = css;
      document.head.appendChild(tag);
    }
    function flattenTodoStack(state) {
      const rows = [];
      const seen = /* @__PURE__ */ new Set();
      const visit = (id, depth) => {
        if (seen.has(id)) return;
        seen.add(id);
        const node = state.nodes[id];
        if (node === void 0) return;
        rows.push({ node, depth });
        for (const childId of node.children) visit(childId, depth + 1);
      };
      for (const rootId of state.roots) visit(rootId, 0);
      return rows;
    }
    function progressLabel(state, t) {
      let pending = 0;
      let completed = 0;
      let dropped = 0;
      for (const node of Object.values(state.nodes)) {
        if (node.status === "pending") pending += 1;
        else if (node.status === "completed") completed += 1;
        else dropped += 1;
      }
      const parts = [];
      const focused = state.focusId === null ? void 0 : state.nodes[state.focusId];
      if (focused !== void 0) parts.push(t("focus.current", { content: focused.content }));
      if (pending > 0) parts.push(t("progress.pending", { count: pending }));
      if (completed > 0) parts.push(t("progress.completed", { count: completed }));
      if (dropped > 0) parts.push(t("progress.dropped", { count: dropped }));
      return parts.join("\u2002\xB7\u2002");
    }
    function ProgressGlyph() {
      const gradientId = (0, import_react.useId)();
      return (0, import_react.createElement)(
        "svg",
        {
          width: 14,
          height: 14,
          viewBox: "0 0 14 14",
          fill: "none",
          "aria-hidden": true
        },
        (0, import_react.createElement)(
          "defs",
          null,
          (0, import_react.createElement)(
            "linearGradient",
            {
              id: gradientId,
              x1: "2.5",
              y1: "12",
              x2: "10.5",
              y2: "3.5",
              gradientUnits: "userSpaceOnUse"
            },
            (0, import_react.createElement)("stop", { stopColor: "currentColor" }),
            (0, import_react.createElement)("stop", { offset: "1", stopColor: "currentColor", stopOpacity: "0" })
          )
        ),
        (0, import_react.createElement)("circle", {
          cx: "7",
          cy: "7",
          r: "6.4",
          stroke: `url(#${gradientId})`,
          strokeWidth: "1.2"
        })
      );
    }
    function PendingGlyph() {
      return (0, import_react.createElement)("svg", {
        width: 14,
        height: 14,
        viewBox: "0 0 14 14",
        fill: "none",
        "aria-hidden": true
      }, (0, import_react.createElement)("circle", {
        cx: "7",
        cy: "7",
        r: "6.4",
        stroke: "currentColor",
        strokeWidth: "1.2",
        strokeDasharray: "2.4 2.4"
      }));
    }
    function StatusGlyph({ node, focused }) {
      if (focused) return (0, import_react.createElement)(ProgressGlyph);
      if (node.status === "completed") return (0, import_react.createElement)(import_dsh_client_ui_primitives.IconCheckOutline14);
      if (node.status === "dropped") return (0, import_react.createElement)(import_dsh_client_ui_primitives.IconCloseFill14);
      return (0, import_react.createElement)(PendingGlyph);
    }
    function TodoStackPanel({
      state,
      t,
      defaultCollapsed = true
    }) {
      const [collapsed, setCollapsed] = (0, import_react.useState)(defaultCollapsed);
      const rows = flattenTodoStack(state);
      if (rows.length === 0) return null;
      return (0, import_react.createElement)("section", {
        className: "todoStackRoot",
        "data-testid": "todo-stack-panel",
        "aria-label": t("title")
      }, (0, import_react.createElement)(
        "div",
        { className: "todoStackBody" },
        (0, import_react.createElement)(
          "button",
          {
            type: "button",
            className: "todoStackHeader",
            "aria-expanded": !collapsed,
            onClick: () => setCollapsed((value) => !value)
          },
          (0, import_react.createElement)("span", { className: "todoStackLead", "aria-hidden": true }, (0, import_react.createElement)(import_dsh_client_ui_primitives.IconChecklistOutline14)),
          (0, import_react.createElement)("span", { className: "todoStackTitle" }, t("title")),
          (0, import_react.createElement)("span", { className: "todoStackProgress" }, progressLabel(state, t)),
          (0, import_react.createElement)(
            "span",
            { className: "todoStackChevron", "aria-hidden": true },
            collapsed ? (0, import_react.createElement)(import_dsh_client_ui_primitives.IconChevronUpOutline14) : (0, import_react.createElement)(import_dsh_client_ui_primitives.IconChevronDownOutline14)
          )
        ),
        !collapsed && (0, import_react.createElement)(
          "ul",
          { className: "todoStackList" },
          ...rows.map(({ node, depth }) => {
            const focused = node.id === state.focusId;
            const visualStatus = focused ? "focused" : node.status;
            const statusLabel = t(`status.${visualStatus}`);
            const rowStyle = { "--todo-indent": `${depth * 18}px` };
            return (0, import_react.createElement)(
              "li",
              {
                key: node.id,
                className: "todoStackRow",
                style: rowStyle,
                "data-depth": depth,
                "data-status": node.status,
                "data-focused": focused,
                "aria-current": focused ? "step" : void 0
              },
              depth > 0 ? (0, import_react.createElement)("span", { className: "todoStackBranch", "aria-hidden": true }) : null,
              (0, import_react.createElement)("span", {
                className: "todoStackGlyph",
                "data-status": visualStatus,
                "aria-label": statusLabel,
                title: statusLabel
              }, (0, import_react.createElement)(StatusGlyph, { node, focused })),
              (0, import_react.createElement)("span", { className: "todoStackContent" }, node.content),
              focused ? (0, import_react.createElement)("span", { className: "todoStackCurrent" }, t("status.focused")) : null
            );
          })
        )
      ));
    }
    function TodoStackDock({ useProjection, t }) {
      const state = useProjection("todoStack");
      return (0, import_react.createElement)(TodoStackPanel, {
        state: state ?? {
          version: 1,
          revision: 0,
          roots: [],
          nodes: {},
          focusId: null
        },
        t
      });
    }
    var inject = ["slots", "locale"];
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "todo-stack: dictionaries");
      ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
        name: "conversation.input.dock",
        id: "todo",
        order: 0,
        priority: -10,
        locale: NS
      }, TodoStackDock));
    }
    return module.exports;
  },
});
