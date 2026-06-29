/*
 * NEC XON (c) Copyright 2025.
 *
 * Workflow roles (2026-06): coordinator > vhw, under admin. The store_manager
 * role was removed (2026-06-22) — coordinator is now the top facility role and
 * carries the same order/accept/allocate capabilities. A legacy KC token still
 * carrying 'store_manager' degrades to coordinator in the web portal.
 * See docs/roles-and-permissions-spec.md.
 */
'use strict';

const ADMIN         = 'admin';   // system administrator — can do everything, all facilities
const COORDINATOR   = 'coordinator';
const VHW           = 'vhw';

// Capability groups (the role lists live in one place). Admin is in every
// supply-chain group; dispensing stays a field (VHW) action.
const CAN_PLACE_ORDER = [ADMIN, COORDINATOR];
const CAN_ACCEPT      = [ADMIN, COORDINATOR]; // existing receipt path (internal/supplier split is a later phase)
const CAN_ALLOCATE    = [ADMIN, COORDINATOR]; // role that allocates to a VHW
const CAN_DISPENSE    = [VHW];

const inGroup = (group) => (role) => group.includes(role);
const canPlaceOrder = inGroup(CAN_PLACE_ORDER);
const canAccept     = inGroup(CAN_ACCEPT);
const canAllocate   = inGroup(CAN_ALLOCATE);
const isVhw         = (role) => role === VHW;     // allocations may only target VHWs
const isAdmin       = (role) => role === ADMIN;   // bypasses facility scope + create limits

// Hierarchy: admin > coordinator > vhw. A user may only CREATE roles strictly
// below their own — so admin can make coordinators/VHWs, and a coordinator can
// make VHWs only.
const RANK = { [ADMIN]: 3, [COORDINATOR]: 2, [VHW]: 1 };
const rank = (r) => RANK[r] || 0;
const canCreateRole = (creatorRole, targetRole) =>
  rank(creatorRole) > 0 && rank(targetRole) > 0 && rank(targetRole) < rank(creatorRole);
// Roles a creator is allowed to assign (for building UI dropdowns).
const creatableRoles = (creatorRole) =>
  [COORDINATOR, VHW].filter((t) => canCreateRole(creatorRole, t));

module.exports = {
  ADMIN, COORDINATOR, VHW,
  CAN_PLACE_ORDER, CAN_ACCEPT, CAN_ALLOCATE, CAN_DISPENSE,
  canPlaceOrder, canAccept, canAllocate, isVhw, isAdmin,
  RANK, rank, canCreateRole, creatableRoles,
};
