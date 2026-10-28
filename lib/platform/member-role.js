// src/platform/member-role.ts
const groupAdminStatus = (event) => {
	if (event.IsPrivate) return null;
	if (event.Role === "owner" || event.Role === "admin") return true;
	if (event.Role === "member") return false;
	return typeof event.IsAdmin === "boolean" ? event.IsAdmin : null;
};

export { groupAdminStatus };