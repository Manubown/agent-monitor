/**
 * `tree(id, depth)`: the session bound to its single `?` and every subagent below it, the session itself at depth 0.
 * Each session has one parent, so a walk that never re-enters a session already on its path visits every session
 * once, also when a malformed log makes a parent cycle (a -> b -> a); the depth limit bounds runaway chains.
 */
export const SUBTREE = `WITH RECURSIVE tree_root(id) AS (SELECT ?),
  tree(id, depth, path) AS (
    SELECT id, 0, char(31) || id || char(31) FROM tree_root
    UNION ALL
    SELECT c.id, tree.depth + 1, tree.path || c.id || char(31) FROM sessions c JOIN tree ON c.parent_id = tree.id
    WHERE tree.depth < 64 AND instr(tree.path, char(31) || c.id || char(31)) = 0)`;
