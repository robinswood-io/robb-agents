import { mainLog } from "../logger";
import type { BrowserCDP } from '../browser-cdp.ts';

// ---------------------------------------------------------------------------
  // Native Mouse Input (uses webContents.sendInputEvent for trusted events)
  // ---------------------------------------------------------------------------

  /**
   * Generate a series of intermediate points between two coordinates.
   * Adds slight curve and jitter for realistic mouse movement.
   */
export function generateTrajectory(_transportOwner: BrowserCDP, fromX: number, fromY: number, toX: number, toY: number, steps: number): Array<{
    x: number;
    y: number;
}> {
    const points: Array<{
        x: number;
        y: number;
    }> = [];
    for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        // Slight arc: offset perpendicular to the line
        const arcOffset = Math.sin(t * Math.PI) * Math.min(15, Math.sqrt((toX - fromX) ** 2 + (toY - fromY) ** 2) * 0.05);
        const dx = toX - fromX;
        const dy = toY - fromY;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const perpX = -dy / len;
        const perpY = dx / len;
        // Small per-step jitter (±2px)
        const jitterX = (Math.random() - 0.5) * 4;
        const jitterY = (Math.random() - 0.5) * 4;
        points.push({
            x: Math.round(fromX + dx * t + perpX * arcOffset + jitterX),
            y: Math.round(fromY + dy * t + perpY * arcOffset + jitterY),
        });
    }
    // Ensure last point is exactly the target
    if (points.length > 0) {
        points[points.length - 1] = { x: Math.round(toX), y: Math.round(toY) };
    }
    return points;
}

// Explicit CDP mouse fallback methods kept for resilience.
export async function clickAtCDP(transportOwner: BrowserCDP, x: number, y: number): Promise<void> {
    await transportOwner["send"]('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        clickCount: 1,
    });
    await transportOwner["send"]('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        clickCount: 1,
    });
}

export async function dragCDP(transportOwner: BrowserCDP, x1: number, y1: number, x2: number, y2: number): Promise<void> {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const distance = Math.sqrt(dx * dx + dy * dy);
    const steps = Math.max(5, Math.min(20, Math.round(distance / 20)));
    let lastX = x1;
    let lastY = y1;
    await transportOwner["send"]('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: x1,
        y: y1,
        button: 'left',
        buttons: 1,
        clickCount: 1,
    });
    try {
        for (let i = 1; i <= steps; i++) {
            const t = i / steps;
            const x = Math.round(x1 + dx * t);
            const y = Math.round(y1 + dy * t);
            await transportOwner["send"]('Input.dispatchMouseEvent', {
                type: 'mouseMoved',
                x,
                y,
                button: 'left',
                buttons: 1,
            });
            lastX = x;
            lastY = y;
            if (i < steps) {
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }
    }
    finally {
        await transportOwner["send"]('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: lastX,
            y: lastY,
            button: 'left',
            buttons: 0,
            clickCount: 1,
        });
    }
}

export async function clickAtCoordinates(transportOwner: BrowserCDP, x: number, y: number): Promise<void> {
    try {
        // Generate short trajectory to the click target for realism
        const startX = x + (Math.random() - 0.5) * 60;
        const startY = y + (Math.random() - 0.5) * 60;
        const trajectory = transportOwner.generateTrajectory(startX, startY, x, y, 3 + Math.floor(Math.random() * 3));
        for (const point of trajectory) {
            transportOwner.sendMouseEvent('mouseMove', point.x, point.y);
            await new Promise(resolve => setTimeout(resolve, 4 + Math.random() * 8));
        }
        transportOwner.sendMouseEvent('mouseDown', Math.round(x), Math.round(y), 'left', 1);
        await new Promise(resolve => setTimeout(resolve, 20 + Math.random() * 40));
        transportOwner.sendMouseEvent('mouseUp', Math.round(x), Math.round(y), 'left', 1);
    }
    catch (error) {
        mainLog.warn(`[browser-cdp] native clickAt failed, falling back to CDP: ${error instanceof Error ? error.message : String(error)}`);
        await transportOwner.clickAtCDP(x, y);
    }
}

export async function drag(transportOwner: BrowserCDP, x1: number, y1: number, x2: number, y2: number): Promise<void> {
    try {
        const dx = x2 - x1;
        const dy = y2 - y1;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const steps = Math.max(5, Math.min(20, Math.round(distance / 20)));
        // Move to start position
        transportOwner.sendMouseEvent('mouseMove', x1, y1);
        await new Promise(resolve => setTimeout(resolve, 10));
        // Press at start position
        transportOwner.sendMouseEvent('mouseDown', x1, y1, 'left', 1);
        await new Promise(resolve => setTimeout(resolve, 30));
        let lastX = x1;
        let lastY = y1;
        try {
            const trajectory = transportOwner.generateTrajectory(x1, y1, x2, y2, steps);
            for (let i = 0; i < trajectory.length; i++) {
                const point = trajectory[i]!;
                transportOwner.sendMouseEvent('mouseMove', point.x, point.y);
                lastX = point.x;
                lastY = point.y;
                if (i < trajectory.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 8 + Math.random() * 12));
                }
            }
        }
        catch (error) {
            // Always release even on error
            transportOwner.sendMouseEvent('mouseUp', lastX, lastY, 'left', 1);
            throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
        transportOwner.sendMouseEvent('mouseUp', lastX, lastY, 'left', 1);
    }
    catch (error) {
        mainLog.warn(`[browser-cdp] native drag failed, falling back to CDP: ${error instanceof Error ? error.message : String(error)}`);
        await transportOwner.dragCDP(x1, y1, x2, y2);
    }
}
