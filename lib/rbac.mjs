export const PERMISSIONS = {
  CREATE_PAGE: "CREATE_PAGE",
  EDIT_PAGE: "EDIT_PAGE",
  REVIEW_EDITS: "REVIEW_EDITS",
  REVERT_EDIT: "REVERT_EDIT",
  PROTECT_PAGE: "PROTECT_PAGE",
  DELETE_PAGE: "DELETE_PAGE",
  RESTORE_PAGE: "RESTORE_PAGE",
  BLOCK_USER: "BLOCK_USER",
  WARN_USER: "WARN_USER",
  MANAGE_USERS: "MANAGE_USERS",
  VIEW_AUDIT: "VIEW_AUDIT",
};

export const ROLE_PERMISSIONS = {
  member: [PERMISSIONS.CREATE_PAGE, PERMISSIONS.EDIT_PAGE],
  contributor: [PERMISSIONS.CREATE_PAGE, PERMISSIONS.EDIT_PAGE],
  trusted_contributor: [PERMISSIONS.CREATE_PAGE, PERMISSIONS.EDIT_PAGE],
  reviewer: [PERMISSIONS.CREATE_PAGE, PERMISSIONS.EDIT_PAGE, PERMISSIONS.REVIEW_EDITS],
  moderator: [
    PERMISSIONS.CREATE_PAGE,
    PERMISSIONS.EDIT_PAGE,
    PERMISSIONS.REVIEW_EDITS,
    PERMISSIONS.REVERT_EDIT,
    PERMISSIONS.PROTECT_PAGE,
    PERMISSIONS.BLOCK_USER,
    PERMISSIONS.WARN_USER,
    PERMISSIONS.VIEW_AUDIT,
  ],
  desk: Object.values(PERMISSIONS),
};

export const DIRECT_PUBLISH_ROLES = new Set(["trusted_contributor", "reviewer", "moderator", "desk"]);

export function permissionsFor(role) {
  return ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS.member;
}

export function can(user, permission) {
  if (!user) return false;
  return permissionsFor(user.role).includes(permission);
}

export function isMod(user) {
  return user?.role === "moderator" || user?.role === "desk";
}

export function canDirectPublish(user) {
  return Boolean(user && DIRECT_PUBLISH_ROLES.has(user.role));
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    username: user.username,
    role: user.role,
    bio: user.bio || "",
    createdAt: user.createdAt,
    emailVerified: Boolean(user.emailVerified),
    permissions: permissionsFor(user.role),
  };
}

export function publicProfile(user, stats = {}) {
  if (!user || user.deletedAt) return null;
  return {
    id: user.id,
    username: user.username,
    name: user.name,
    bio: user.bio || "",
    role: user.role,
    createdAt: user.createdAt,
    ...stats,
  };
}
