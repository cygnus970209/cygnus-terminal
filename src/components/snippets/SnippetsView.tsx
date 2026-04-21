import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./SnippetsView.css";

interface Snippet {
  id: number;
  title: string;
  command: string;
  category: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface SnippetsViewProps {
  onExecute?: (command: string) => void;
}

export default function SnippetsView({ onExecute }: SnippetsViewProps) {
  const [snippets, setSnippets] = useState<Snippet[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState<number | null>(null);
  const [title, setTitle] = useState("");
  const [command, setCommand] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");

  const loadSnippets = useCallback(async () => {
    try {
      const list = await invoke<Snippet[]>("list_snippets", {
        query: searchQuery || null,
      });
      setSnippets(list);
    } catch (err) {
      console.error("Failed to load snippets:", err);
    }
  }, [searchQuery]);

  useEffect(() => {
    loadSnippets();
  }, [loadSnippets]);

  const resetForm = () => {
    setTitle("");
    setCommand("");
    setCategory("");
    setDescription("");
    setEditId(null);
    setShowAdd(false);
  };

  const handleSave = async () => {
    if (!title.trim() || !command.trim()) return;
    try {
      if (editId) {
        await invoke("update_snippet", {
          id: editId,
          req: {
            title: title.trim(),
            command: command.trim(),
            category: category.trim() || null,
            description: description.trim() || null,
          },
        });
      } else {
        await invoke("create_snippet", {
          req: {
            title: title.trim(),
            command: command.trim(),
            category: category.trim() || null,
            description: description.trim() || null,
          },
        });
      }
      resetForm();
      loadSnippets();
    } catch (err) {
      console.error("Failed to save snippet:", err);
    }
  };

  const handleEdit = (s: Snippet) => {
    setEditId(s.id);
    setTitle(s.title);
    setCommand(s.command);
    setCategory(s.category);
    setDescription(s.description || "");
    setShowAdd(true);
  };

  const handleDelete = async (id: number) => {
    try {
      await invoke("delete_snippet", { id });
      loadSnippets();
    } catch (err) {
      console.error("Failed to delete snippet:", err);
    }
  };

  const grouped = snippets.reduce<Record<string, Snippet[]>>((acc, s) => {
    const cat = s.category || "Uncategorized";
    (acc[cat] ??= []).push(s);
    return acc;
  }, {});

  return (
    <div className="snip-container">
      <div className="snip-toolbar">
        <input
          className="snip-search"
          type="text"
          placeholder="Search snippets..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        <button
          className="snip-new-btn"
          onClick={() => {
            if (showAdd) resetForm();
            else setShowAdd(true);
          }}
        >
          {showAdd ? "Cancel" : "+ New Snippet"}
        </button>
      </div>

      {showAdd && (
        <div className="snip-form">
          <input
            type="text"
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoFocus
          />
          <textarea
            placeholder="Command (supports multi-line)"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            rows={3}
          />
          <div className="snip-form-row">
            <input
              type="text"
              placeholder="Category"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              style={{ flex: 1 }}
            />
            <input
              type="text"
              placeholder="Description (optional)"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              style={{ flex: 2 }}
            />
          </div>
          <button className="snip-save-btn" onClick={handleSave}>
            {editId ? "Update" : "Save"}
          </button>
        </div>
      )}

      <div className="snip-list">
        {Object.entries(grouped).map(([cat, items]) => (
          <div key={cat} className="snip-group">
            {cat !== "Uncategorized" && (
              <div className="snip-group-label">{cat}</div>
            )}
            {items.map((s) => (
              <div key={s.id} className="snip-item">
                <div
                  className="snip-item-main"
                  onClick={() => onExecute?.(s.command)}
                  title={s.description || s.command}
                >
                  <div className="snip-item-header">
                    <span className="snip-item-title">{s.title}</span>
                  </div>
                  <span className="snip-item-cmd">{s.command}</span>
                  {s.description && (
                    <span className="snip-item-desc">{s.description}</span>
                  )}
                </div>
                <div className="snip-item-actions">
                  <button
                    className="snip-action-btn"
                    onClick={() => handleEdit(s)}
                    title="Edit"
                  >
                    ✎
                  </button>
                  <button
                    className="snip-action-btn snip-action-danger"
                    onClick={() => handleDelete(s.id)}
                    title="Delete"
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
        {snippets.length === 0 && !showAdd && (
          <div className="snip-empty">
            No snippets yet. Click "+ New Snippet" to create one.
          </div>
        )}
      </div>
    </div>
  );
}
