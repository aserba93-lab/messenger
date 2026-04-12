import { prisma } from "../db/prisma.js";

export function normDept(s) {
    return (s ?? "").trim().toLowerCase();
}

/** Токены отделов из строки: «Продажи, Маркетинг» или один отдел без запятой. */
export function parseDeptTokens(s) {
    return (s ?? "")
        .split(/[,;]+/)
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
}

/** Есть ли пересечение отделов у двух сотрудников (для менеджеров и DM/групп). */
export function departmentsOverlap(deptA, deptB) {
    const a = parseDeptTokens(deptA);
    const b = parseDeptTokens(deptB);
    if (!a.length && !b.length)
        return true;
    if (!a.length || !b.length)
        return false;
    const setB = new Set(b);
    return a.some((x) => setB.has(x));
}

export function isElevatedOrgRole(role) {
    return role === "owner" || role === "admin";
}

/** Ограничение «только свой отдел» действует для роли manager. */
export function isDeptRestrictedRole(role) {
    return role === "manager";
}

export function orderedPair(userIdA, userIdB) {
    const a = String(userIdA);
    const b = String(userIdB);
    return a < b ? [a, b] : [b, a];
}

export async function hasDepartmentGrant(organizationId, userIdA, userIdB) {
    const [ua, ub] = orderedPair(userIdA, userIdB);
    const g = await prisma.departmentChatGrant.findUnique({
        where: {
            organizationId_userAId_userBId: { organizationId, userAId: ua, userBId: ub },
        },
    });
    return Boolean(g);
}

/**
 * Менеджер может общаться с peer: пересечение по отделам (несколько отделов через запятую), или peer — owner/admin.
 */
export async function managerCanReachPeer(params) {
    const { managerDept, managerRole, peerDept, peerRole } = params;
    if (!isDeptRestrictedRole(managerRole))
        return true;
    if (isElevatedOrgRole(peerRole))
        return true;
    if (departmentsOverlap(managerDept, peerDept))
        return true;
    return false;
}

export async function loadMembersMap(organizationId, userIds) {
    const uniq = [...new Set(userIds.map((x) => String(x)))];
    if (!uniq.length)
        return new Map();
    const rows = await prisma.organizationMember.findMany({
        where: { organizationId, userId: { in: uniq } },
        select: { userId: true, department: true, role: true },
    });
    const m = new Map();
    for (const r of rows)
        m.set(r.userId, r);
    return m;
}

/**
 * Проверка группы: для каждого участника с ролью manager — доступ к каждому другому участнику.
 */
export async function validateGroupMembersDepartmentRules(organizationId, memberUserIds) {
    const ids = [...new Set(memberUserIds.map((x) => String(x)))];
    const map = await loadMembersMap(organizationId, ids);
    for (const uid of ids) {
        const me = map.get(uid);
        if (!me || !isDeptRestrictedRole(me.role))
            continue;
        for (const otherId of ids) {
            if (otherId === uid)
                continue;
            const peer = map.get(otherId);
            if (!peer)
                throw new Error("Участник не в организации");
            const ok = await managerCanReachPeer({
                organizationId,
                managerId: uid,
                managerDept: me.department,
                managerRole: me.role,
                peerId: otherId,
                peerDept: peer.department,
                peerRole: peer.role,
            });
            if (!ok)
                throw new Error("Менеджер может добавлять в группу только коллег из своих отделов (пересечение списков отделов)");
        }
    }
}
