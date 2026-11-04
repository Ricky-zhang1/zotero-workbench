/** Pure reader-control helpers plus the small React control compiled into the panel. */

export function readerHighlightTypeOptions(presets) {
  return presets.HIGHLIGHT_TYPES.map(type => {
    const paired = presets.HIGHLIGHT_PRESETS.find(preset => preset.typeId === type.id);
    const color = presets.HIGHLIGHT_COLORS.find(entry => entry.id === paired?.colorId)
      ?? presets.HIGHLIGHT_COLORS[0];
    return { id: type.id, label: `${type.label} · ${color.label}`, colorId: color.id, color: color.color };
  });
}

export function readerHighlightColorOptions(presets) {
  return presets.HIGHLIGHT_COLORS.map(color => ({
    id: color.id,
    label: `${color.label} · ${color.color}`,
    color: color.color,
  }));
}

/** Shape a strict create_reader_highlight payload; no comment or inferred type is added. */
export function readerHighlightWriteArgs(presets, selection) {
  const metadata = presets.highlightPresetWriteMetadata(selection);
  return { color: metadata.color, tags: [...metadata.tags] };
}

/** Existing deduplicated highlights retain their Zotero tags and are never retyped. */
export function readerHighlightSaveNotice(presets, result, selection) {
  if (result?.existing === true) {
    const original = presets.annotationHighlightType({ tags: result.tags });
    return `原文已有 Zotero 高亮，原类型为“${original.typeLabel}”；本次没有修改其类型。`;
  }
  if (result?.saved === true && result?.verified === true)
    return `高亮已保存：${presets.highlightPresetLabel(selection)}。`;
  return null;
}

/**
 * Rendered in the selected-text popover. `ar`, `wh`, `en`, and
 * `wbSaveReaderHighlight` are provided by the pinned panel and its extension.
 */
export function WorkbenchReaderHighlightControls({ quote, notify, onSaved, presets = wbHighlightPresets }) {
  const [selection, setSelection] = ar.useState(() => presets.getHighlightPresetPreference(en.widgetState));
  const [ready, setReady] = ar.useState(false);
  const [saving, setSaving] = ar.useState(false);

  ar.useEffect(() => {
    let current = true;
    en.ready().then(() => {
      if (!current) return;
      setSelection(presets.getHighlightPresetPreference(en.widgetState));
      setReady(true);
    }).catch(() => {
      if (current) setReady(true);
    });
    return () => { current = false; };
  }, []);

  const persist = value => {
    const next = presets.normalizeHighlightPreset(value);
    setSelection(next);
    const nextState = presets.setHighlightPresetPreference(en.widgetState, next);
    void en.setWidgetState({
      [presets.HIGHLIGHT_PRESET_WIDGET_STATE_KEY]: nextState[presets.HIGHLIGHT_PRESET_WIDGET_STATE_KEY],
    });
  };

  const changeType = event => {
    const typeId = event.target.value;
    const paired = presets.HIGHLIGHT_PRESETS.find(preset => preset.typeId === typeId);
    persist({ typeId, colorId: paired?.colorId ?? selection.colorId });
  };
  const changeColor = event => persist({ typeId: selection.typeId, colorId: event.target.value });

  const save = async () => {
    if (!ready || saving) return;
    setSaving(true);
    try {
      const args = readerHighlightWriteArgs(presets, selection);
      const result = await wbSaveReaderHighlight(quote, args);
      const notice = readerHighlightSaveNotice(presets, result, selection);
      if (!notice) throw new Error('保存请求尚未回读核实；请刷新核对，勿重复保存。');
      notify(notice);
      onSaved?.(result);
    } catch (error) {
      notify(error?.message || String(error), 'error');
    } finally {
      setSaving(false);
    }
  };

  const typeOptions = readerHighlightTypeOptions(presets);
  const colorOptions = readerHighlightColorOptions(presets);
  const controlStyle = {
    display: 'grid',
    gridTemplateColumns: '68px minmax(0,1fr)',
    alignItems: 'center',
    gap: '6px',
    width: '100%',
    fontSize: '12px',
  };
  const selectStyle = {
    boxSizing: 'border-box',
    minWidth: 0,
    width: '100%',
    border: '1px solid var(--z-border-strong)',
    borderRadius: '6px',
    padding: '5px 7px',
    color: 'var(--z-fg)',
    background: 'var(--z-card)',
    font: 'inherit',
  };

  return wh('div', { className: 'wb-highlight-controls', style: { display: 'grid', gap: '7px', width: '100%', flexBasis: '100%' } },
    wh('label', { style: controlStyle },
      wh('span', null, '类型预设'),
      wh('select', { value: selection.typeId, disabled: !ready || saving, onChange: changeType, 'aria-label': '高亮类型预设', style: selectStyle },
        ...typeOptions.map(option => wh('option', { key: option.id, value: option.id }, option.label))),
    ),
    wh('label', { style: controlStyle },
      wh('span', null, '颜色'),
      wh('select', { value: selection.colorId, disabled: !ready || saving, onChange: changeColor, 'aria-label': '高亮颜色', style: selectStyle },
        ...colorOptions.map(option => wh('option', { key: option.id, value: option.id }, option.label))),
    ),
    wh('div', { style: { display: 'flex', alignItems: 'center', gap: '7px', color: 'var(--z-fg2)', fontSize: '11px' } },
      wh('span', { 'aria-hidden': 'true', style: { width: '10px', height: '10px', flex: 'none', borderRadius: '50%', background: selection.color, border: '1px solid color-mix(in srgb, var(--z-fg) 18%, transparent)' } }),
      `${selection.typeLabel} · ${selection.colorLabel}`,
    ),
    wh('button', { type: 'button', className: 'btn ghost sm', disabled: !ready || saving, onClick: save }, saving ? '保存并核对中…' : '高亮并保存'),
  );
}
