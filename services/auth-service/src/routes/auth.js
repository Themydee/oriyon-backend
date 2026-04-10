import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../index";
import { authUsers, refreshTokens, setupTokens } from "../db/schema";
import { publishEvent } from "../rabbitmq";
import { EVENTS } from "../types";
const router = Router();
// ─────────────────────────────────────────────
// SCHEMAS
// ─────────────────────────────────────────────
const loginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(6),
});
const setPasswordSchema = z.object({
    token: z.string(),
    password: z.string().min(8, "Password must be at least 8 characters"),
});
const forgotPasswordSchema = z.object({
    email: z.string().email(),
});
const resetPasswordSchema = z.object({
    token: z.string(),
    password: z.string().min(8, "Password must be at least 8 characters"),
});
const changePasswordSchema = z.object({
    currentPassword: z.string(),
    newPassword: z.string().min(8, "Password must be at least 8 characters"),
});
// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function generateAccessToken(user) {
    return jwt.sign({ userId: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: (process.env.JWT_EXPIRES_IN || "15m") });
}
function generateRefreshToken(userId) {
    return jwt.sign({ userId }, process.env.JWT_REFRESH_SECRET, { expiresIn: (process.env.JWT_REFRESH_EXPIRES_IN || "7d") });
}
async function saveRefreshToken(userId, token) {
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
    await db.insert(refreshTokens).values({ userId, token, expiresAt });
}
// ─────────────────────────────────────────────
// POST /auth/login
// ─────────────────────────────────────────────
router.post("/login", async (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: "Invalid input", details: parsed.error.flatten() });
    }
    const { email, password } = parsed.data;
    try {
        const [user] = await db
            .select()
            .from(authUsers)
            .where(eq(authUsers.email, email))
            .limit(1);
        if (!user || !user.isActive) {
            return res.status(401).json({ error: "Invalid credentials" });
        }
        // Guard: user exists but has never set a password yet
        if (!user.passwordHash) {
            return res.status(403).json({ error: "Account setup not complete. Please check your email for a setup link." });
        }
        const valid = await bcrypt.compare(password, user.passwordHash);
        if (!valid) {
            return res.status(401).json({ error: "Invalid credentials" });
        }
        const accessToken = generateAccessToken(user);
        const refreshToken = generateRefreshToken(user.id);
        await saveRefreshToken(user.id, refreshToken);
        await db
            .update(authUsers)
            .set({ lastLoginAt: new Date() })
            .where(eq(authUsers.id, user.id));
        await publishEvent(EVENTS.USER_LOGGED_IN, {
            userId: user.id,
            email: user.email,
            timestamp: new Date().toISOString(),
        });
        return res.json({ accessToken, refreshToken, role: user.role });
    }
    catch (err) {
        console.error("[auth] login error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// ─────────────────────────────────────────────
// POST /auth/refresh
// ─────────────────────────────────────────────
router.post("/refresh", async (req, res) => {
    const { refreshToken } = req.body;
    if (!refreshToken)
        return res.status(400).json({ error: "Refresh token required" });
    try {
        const payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
        const [stored] = await db
            .select()
            .from(refreshTokens)
            .where(eq(refreshTokens.token, refreshToken))
            .limit(1);
        if (!stored || stored.expiresAt < new Date()) {
            return res.status(401).json({ error: "Invalid or expired refresh token" });
        }
        const [user] = await db
            .select()
            .from(authUsers)
            .where(eq(authUsers.id, payload.userId))
            .limit(1);
        if (!user || !user.isActive) {
            return res.status(401).json({ error: "User not found or inactive" });
        }
        const accessToken = generateAccessToken(user);
        return res.json({ accessToken });
    }
    catch {
        return res.status(401).json({ error: "Invalid refresh token" });
    }
});
// ─────────────────────────────────────────────
// POST /auth/logout
// ─────────────────────────────────────────────
router.post("/logout", async (req, res) => {
    const { refreshToken } = req.body;
    if (refreshToken) {
        await db.delete(refreshTokens).where(eq(refreshTokens.token, refreshToken));
    }
    return res.json({ message: "Logged out" });
});
// ─────────────────────────────────────────────
// GET /auth/verify  — called internally by api-gateway
// ─────────────────────────────────────────────
router.get("/verify", (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
        return res.status(401).json({ valid: false });
    }
    try {
        const token = authHeader.split(" ")[1];
        const payload = jwt.verify(token, process.env.JWT_SECRET);
        return res.json({ valid: true, payload });
    }
    catch {
        return res.status(401).json({ valid: false });
    }
});
// ─────────────────────────────────────────────
// POST /auth/set-password
// First-time password setup via emailed token
// ─────────────────────────────────────────────
router.post("/set-password", async (req, res) => {
    const parsed = setPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { token, password } = parsed.data;
    try {
        const [setupToken] = await db
            .select()
            .from(setupTokens)
            .where(eq(setupTokens.token, token))
            .limit(1);
        if (!setupToken) {
            return res.status(400).json({ error: "Invalid token" });
        }
        if (setupToken.used) {
            return res.status(400).json({ error: "Token has already been used" });
        }
        if (setupToken.expiresAt < new Date()) {
            return res.status(400).json({ error: "Token has expired. Please contact support." });
        }
        const passwordHash = await bcrypt.hash(password, 12);
        // Save password + activate account
        await db
            .update(authUsers)
            .set({ passwordHash, isActive: true, updatedAt: new Date() })
            .where(eq(authUsers.id, setupToken.userId));
        // Invalidate the token
        await db
            .update(setupTokens)
            .set({ used: true })
            .where(eq(setupTokens.id, setupToken.id));
        // Log them in immediately
        const [user] = await db
            .select()
            .from(authUsers)
            .where(eq(authUsers.id, setupToken.userId))
            .limit(1);
        const accessToken = generateAccessToken(user);
        const refreshToken = generateRefreshToken(user.id);
        await saveRefreshToken(user.id, refreshToken);
        await db
            .update(authUsers)
            .set({ lastLoginAt: new Date() })
            .where(eq(authUsers.id, user.id));
        return res.json({ accessToken, refreshToken, role: user.role });
    }
    catch (err) {
        console.error("[auth] set-password error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// ─────────────────────────────────────────────
// POST /auth/forgot-password
// User requests a password reset link
// ─────────────────────────────────────────────
router.post("/forgot-password", async (req, res) => {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { email } = parsed.data;
    // Always return 200 — never reveal whether the email exists
    const genericResponse = { message: "If that email is registered, a reset link has been sent." };
    try {
        const [user] = await db
            .select()
            .from(authUsers)
            .where(eq(authUsers.email, email))
            .limit(1);
        if (!user || !user.isActive)
            return res.json(genericResponse);
        const token = crypto.randomBytes(32).toString("hex");
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
        await db.insert(setupTokens).values({ userId: user.id, token, expiresAt });
        await publishEvent(EVENTS.PASSWORD_RESET_REQUESTED, {
            userId: user.id,
            email: user.email,
            token,
            expiresAt: expiresAt.toISOString(),
        });
        return res.json(genericResponse);
    }
    catch (err) {
        console.error("[auth] forgot-password error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// ─────────────────────────────────────────────
// POST /auth/reset-password
// Submit a new password using a reset token
// ─────────────────────────────────────────────
router.post("/reset-password", async (req, res) => {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { token, password } = parsed.data;
    try {
        const [setupToken] = await db
            .select()
            .from(setupTokens)
            .where(eq(setupTokens.token, token))
            .limit(1);
        if (!setupToken || setupToken.used || setupToken.expiresAt < new Date()) {
            return res.status(400).json({ error: "Invalid or expired token" });
        }
        const passwordHash = await bcrypt.hash(password, 12);
        await db
            .update(authUsers)
            .set({ passwordHash, updatedAt: new Date() })
            .where(eq(authUsers.id, setupToken.userId));
        await db
            .update(setupTokens)
            .set({ used: true })
            .where(eq(setupTokens.id, setupToken.id));
        // Invalidate all existing sessions on all devices
        await db
            .delete(refreshTokens)
            .where(eq(refreshTokens.userId, setupToken.userId));
        return res.json({ message: "Password reset successfully. Please log in." });
    }
    catch (err) {
        console.error("[auth] reset-password error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
// ─────────────────────────────────────────────
// PATCH /auth/change-password
// Logged-in user changes their own password
// Requires: x-user-id header (injected by gateway)
// ─────────────────────────────────────────────
router.patch("/change-password", async (req, res) => {
    const userId = req.headers["x-user-id"];
    if (!userId)
        return res.status(401).json({ error: "Unauthorized" });
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.flatten() });
    }
    const { currentPassword, newPassword } = parsed.data;
    try {
        const [user] = await db
            .select()
            .from(authUsers)
            .where(eq(authUsers.id, userId))
            .limit(1);
        if (!user)
            return res.status(404).json({ error: "User not found" });
        if (!user.passwordHash) {
            return res.status(400).json({ error: "No password set on this account" });
        }
        const valid = await bcrypt.compare(currentPassword, user.passwordHash);
        if (!valid)
            return res.status(401).json({ error: "Current password is incorrect" });
        if (currentPassword === newPassword) {
            return res.status(400).json({ error: "New password must be different from current password" });
        }
        const passwordHash = await bcrypt.hash(newPassword, 12);
        await db
            .update(authUsers)
            .set({ passwordHash, updatedAt: new Date() })
            .where(eq(authUsers.id, userId));
        // Invalidate all refresh tokens — forces re-login on all other devices
        await db
            .delete(refreshTokens)
            .where(eq(refreshTokens.userId, userId));
        return res.json({ message: "Password changed successfully. Please log in again." });
    }
    catch (err) {
        console.error("[auth] change-password error:", err);
        return res.status(500).json({ error: "Internal server error" });
    }
});
export default router;
