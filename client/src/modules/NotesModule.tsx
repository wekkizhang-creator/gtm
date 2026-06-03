import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import type { StickyNote } from '../types';

const COLORS = ['#fff2a8', '#d8f5d0', '#d7ecff', '#ffe1ef', '#eee4ff'];

export default function NotesModule() {
  const [notes, setNotes] = useState<StickyNote[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [color, setColor] = useState(COLORS[0]);
  const [error, setError] = useState<string | null>(null);

  const selected = notes.find((note) => note.id === selectedId) ?? null;

  const reload = useCallback(async () => {
    try {
      const list = await api.listNotes();
      setNotes(list);
      setSelectedId((current) => current ?? list[0]?.id ?? null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (!selected) {
      setTitle('');
      setBody('');
      setColor(COLORS[0]);
      return;
    }
    setTitle(selected.title);
    setBody(selected.body);
    setColor(selected.color ?? COLORS[0]);
  }, [selected?.id]);

  async function create() {
    try {
      const note = await api.createNote({ title: '新便签', body: '' });
      setNotes((items) => [note, ...items]);
      setSelectedId(note.id);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function save() {
    if (!selected) return;
    try {
      const note = await api.updateNote(selected.id, { title: title.trim() || '未命名便签', body, color });
      setNotes((items) => items.map((item) => (item.id === note.id ? note : item)));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function remove() {
    if (!selected) return;
    try {
      await api.deleteNote(selected.id);
      const next = notes.filter((item) => item.id !== selected.id);
      setNotes(next);
      setSelectedId(next[0]?.id ?? null);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function convert() {
    if (!selected) return;
    try {
      const result = await api.convertNoteToTask(selected.id);
      setNotes((items) => items.map((item) => (item.id === result.note.id ? result.note : item)));
      setSelectedId(result.note.id);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <main className="notes-main">
      <aside className="notes-list">
        <div className="notes-toolbar">
          <h1>便签</h1>
          <button onClick={() => void create()}>新建</button>
        </div>
        {error && <div className="banner banner-error">⚠ {error}</div>}
        {notes.length === 0 && <div className="empty">还没有便签</div>}
        {notes.map((note) => (
          <button
            key={note.id}
            className={`note-list-item${selectedId === note.id ? ' active' : ''}`}
            onClick={() => setSelectedId(note.id)}
          >
            <span className="note-dot" style={{ background: note.color ?? COLORS[0] }} />
            <span>{note.title}</span>
            {note.taskId && <small>已关联任务</small>}
          </button>
        ))}
      </aside>

      <section className="note-editor">
        {selected ? (
          <div className="note-paper" style={{ background: color }}>
            <input className="note-title-input" value={title} onChange={(e) => setTitle(e.target.value)} onBlur={() => void save()} />
            <textarea className="note-body-input" value={body} onChange={(e) => setBody(e.target.value)} onBlur={() => void save()} />
            <div className="note-actions">
              <div className="note-colors">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    className={`note-color${color === c ? ' active' : ''}`}
                    style={{ background: c }}
                    onClick={() => {
                      setColor(c);
                      void api.updateNote(selected.id, { color: c }).then((note) => setNotes((items) => items.map((item) => (item.id === note.id ? note : item))));
                    }}
                  />
                ))}
              </div>
              <button onClick={() => void convert()}>{selected.taskId ? '查看关联任务' : '转为任务'}</button>
              <button className="btn-danger" onClick={() => void remove()}>删除</button>
            </div>
          </div>
        ) : (
          <div className="note-empty">
            <button onClick={() => void create()}>创建第一张便签</button>
          </div>
        )}
      </section>
    </main>
  );
}
