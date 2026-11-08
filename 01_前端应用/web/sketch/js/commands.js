/* =============================================================================
   参数化草图 · 命令栈（Command 模式）
   每个用户操作是一条命令：do / undo 明确可逆；几何解按变量快照随命令一起回滚。
   ========================================================================== */

export class CommandStack {
  constructor(limit = 200) {
    this.limit = limit;
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = [];
  }

  on(fn) { this.listeners.push(fn); }
  _emit() { for (const fn of this.listeners) fn(this); }

  /**
   * 执行命令。
   * @param cmd {label, do(doc), undo(doc)}
   * @param doc
   * @param solve 求解回调（返回诊断），执行后调用
   */
  execute(cmd, doc, solve) {
    const vBefore = doc.snapshotVars();
    cmd.do(doc);
    const result = solve ? solve() : null;
    const vAfter = doc.snapshotVars();
    this.undoStack.push({ cmd, vBefore, vAfter, result, label: cmd.label });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this._emit();
    return result;
  }

  undo(doc) {
    const item = this.undoStack.pop();
    if (!item) return false;
    item.cmd.undo(doc);
    doc.restoreVars(item.vBefore);
    this.redoStack.push(item);
    this._emit();
    return true;
  }

  redo(doc) {
    const item = this.redoStack.pop();
    if (!item) return false;
    item.cmd.do(doc);
    doc.restoreVars(item.vAfter);
    this.undoStack.push(item);
    this._emit();
    return true;
  }

  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  /** 记录一次已经生效的修改（如拖动）：只回滚变量快照 */
  record(label, vBefore, vAfter) {
    this.undoStack.push({
      cmd: { label, do() {}, undo() {} },
      vBefore,
      vAfter: vAfter || vBefore,
      label,
    });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack.length = 0;
    this._emit();
  }

  recordAfter(vAfter) {
    const top = this.undoStack[this.undoStack.length - 1];
    if (top && !top.vAfter) top.vAfter = vAfter;
  }

  topLabel() { return this.undoStack.length ? this.undoStack[this.undoStack.length - 1].label : ''; }

  clear() { this.undoStack.length = 0; this.redoStack.length = 0; this._emit(); }
}

/* ---------------- 具体命令 ---------------- */

export function cmdAddEntities(entities, constraints) {
  return {
    label: '新建图元',
    do(doc) {
      for (const e of entities) doc.entities.set(e.id, { ...e });
      for (const c of constraints || []) doc.constraints.set(c.id, { ...c });
    },
    undo(doc) {
      for (const c of constraints || []) doc.constraints.delete(c.id);
      for (const e of entities) doc.entities.delete(e.id);
    },
  };
}

export function cmdAddConstraint(constraint) {
  return {
    label: '添加约束',
    do(doc) { doc.constraints.set(constraint.id, { ...constraint }); },
    undo(doc) { doc.constraints.delete(constraint.id); },
  };
}

export function cmdRemoveConstraint(constraint) {
  return {
    label: '删除约束',
    do(doc) { doc.constraints.delete(constraint.id); },
    undo(doc) { doc.constraints.set(constraint.id, { ...constraint }); },
  };
}

export function cmdDeleteSelection(entityIds, constraintIds) {
  let removed = null;
  let removedCons = null;
  return {
    label: '删除',
    do(doc) {
      removed = [];
      removedCons = [];
      // 先保存被引用约束与实体（含级联）
      const entSet = new Set(entityIds);
      // 级联：点被删则其端点线/圆也删
      for (const id of [...entSet]) {
        const e = doc.entities.get(id);
        if (!e) continue;
        if (e.type === 'point') {
          for (const o of doc.entities.values()) {
            if (o.type === 'line' && (o.p1 === id || o.p2 === id)) entSet.add(o.id);
            if ((o.type === 'circle' || o.type === 'arc') && o.center === id) entSet.add(o.id);
          }
        }
      }
      for (const cid of constraintIds || []) {
        const c = doc.constraints.get(cid);
        if (c) removedCons.push(JSON.parse(JSON.stringify(c)));
      }
      for (const id of entSet) {
        const e = doc.entities.get(id);
        if (e) removed.push(JSON.parse(JSON.stringify(e)));
      }
      // 引用了待删实体的约束也要保存并删除
      const refIds = [...entSet];
      for (const c of doc.constraints.values()) {
        if (refIds.some((id) => JSON.stringify(c.refs).indexOf(id) >= 0)) {
          if (!removedCons.find((x) => x.id === c.id)) removedCons.push(JSON.parse(JSON.stringify(c)));
        }
      }
      for (const c of removedCons) doc.constraints.delete(c.id);
      for (const id of entSet) doc.entities.delete(id);
    },
    undo(doc) {
      for (const e of removed || []) doc.entities.set(e.id, { ...e });
      for (const c of removedCons || []) doc.constraints.set(c.id, { ...c });
    },
  };
}

export function cmdEditValue(constraint, value) {
  const before = constraint.value;
  return {
    label: '修改尺寸',
    do(doc) { const c = doc.constraints.get(constraint.id); if (c) c.value = value; },
    undo(doc) { const c = doc.constraints.get(constraint.id); if (c) c.value = before; },
  };
}

/** 拖动/移动：do 只在首次应用，撤销靠变量快照 */
export function cmdMove(label, applyFn) {
  return {
    label: label || '移动',
    do(doc) { applyFn(doc); },
    undo() { /* 由变量快照回滚 */ },
  };
}
