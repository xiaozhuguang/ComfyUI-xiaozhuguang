export function egui_text_agent_session() { return { active: false }; }
export function egui_text_agent_activate(session, active) { session.active = active; }
export function egui_text_agent_listener(session, callback) { return event => { if (session.active) callback(event); }; }