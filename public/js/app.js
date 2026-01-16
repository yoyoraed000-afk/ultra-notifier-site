// ============================================================
// ULTRA NOTIFIER - Frontend JavaScript
// ============================================================

// Format relative time
function formatTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
    return `${Math.floor(seconds / 86400)}d ago`;
}

// Get brainrot image URL
function getBrainrotImageUrl(name) {
    const formatted = name.toLowerCase().replace(/ /g, '_').replace(/[^a-z0-9_]/g, '');
    return `https://calculadora.estevao1098.com/images/brainrots/${formatted}.png`;
}

// Create log item HTML
function createLogItem(log) {
    const imageUrl = log.image_url || getBrainrotImageUrl(log.brainrot_name);
    return `
        <div class="log-item" data-id="${log.id}">
            <img src="${imageUrl}" alt="${log.brainrot_name}" onerror="this.style.display='none'">
            <div class="log-info">
                <span class="log-name">${log.brainrot_name}</span>
                <span class="log-value">${log.brainrot_value}</span>
            </div>
            <span class="log-time">${formatTimeAgo(log.timestamp)}</span>
        </div>
    `;
}

// Real-time logs connection
let logsEventSource = null;
let currentLogs = [];

function connectToLogs() {
    if (logsEventSource) {
        logsEventSource.close();
    }
    
    logsEventSource = new EventSource('/api/logs/stream');
    
    logsEventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.type === 'init') {
            // Initial load of logs
            currentLogs = data.logs;
            renderLogs();
        } else if (data.type === 'new') {
            // New log arrived - add with animation
            currentLogs.unshift(data.log);
            if (currentLogs.length > 20) currentLogs.pop();
            addNewLogWithAnimation(data.log);
        }
    };
    
    logsEventSource.onerror = () => {
        console.log('Logs connection lost, reconnecting...');
        setTimeout(connectToLogs, 3000);
    };
}

function renderLogs() {
    const ticker = document.getElementById('logsTicker');
    if (!ticker) return;
    
    if (currentLogs.length === 0) {
        ticker.innerHTML = '<div class="no-logs">Waiting for brainrot finds...</div>';
        return;
    }
    
    // Clear ticker
    ticker.innerHTML = '';
    
    // Render logs (newest first on the left)
    const logsToShow = currentLogs.slice(0, 10);
    logsToShow.forEach(log => {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = createLogItem(log);
        ticker.appendChild(tempDiv.firstElementChild);
    });
    
    // Remove items that overflow the container
    removeOverflowItems(ticker);
}

function addNewLogWithAnimation(log) {
    const ticker = document.getElementById('logsTicker');
    if (!ticker) return;
    
    // Remove "no logs" message if present
    const noLogs = ticker.querySelector('.no-logs');
    if (noLogs) noLogs.remove();
    
    // Create new element
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = createLogItem(log);
    const newItem = tempDiv.firstElementChild;
    newItem.classList.add('new-log');
    
    // Insert at the LEFT (beginning)
    ticker.insertBefore(newItem, ticker.firstChild);
    
    // Remove animation class after animation
    setTimeout(() => newItem.classList.remove('new-log'), 600);
    
    // After animation, check for overflow and remove items on the right
    setTimeout(() => removeOverflowItems(ticker), 100);
}

function removeOverflowItems(ticker) {
    if (!ticker) return;
    
    const containerWidth = ticker.parentElement.clientWidth - 150; // Account for LIVE indicator
    let totalWidth = 0;
    
    const items = ticker.querySelectorAll('.log-item');
    items.forEach((item, index) => {
        totalWidth += item.offsetWidth + 15; // 15px gap
        
        // If this item exceeds container, fade it out
        if (totalWidth > containerWidth) {
            item.style.opacity = '0';
            item.style.transform = 'scale(0.8)';
            setTimeout(() => item.remove(), 300);
        }
    });
}

// Update time displays periodically
function updateLogTimes() {
    document.querySelectorAll('.log-item').forEach(item => {
        const id = item.dataset.id;
        const log = currentLogs.find(l => l.id == id);
        if (log) {
            const timeEl = item.querySelector('.log-time');
            if (timeEl) timeEl.textContent = formatTimeAgo(log.timestamp);
        }
    });
}

// Check authentication status
async function checkAuth() {
    try {
        const response = await fetch('/api/user');
        const data = await response.json();
        
        if (data.authenticated) {
            updateUIForLoggedInUser(data.user);
        }
    } catch (error) {
        console.log('Not authenticated');
    }
}

// Update UI for logged in user
function updateUIForLoggedInUser(user) {
    const loginBtn = document.getElementById('loginBtn');
    if (loginBtn) {
        loginBtn.innerHTML = `
            <img src="https://cdn.discordapp.com/avatars/${user.discord_id}/${user.avatar}.png" 
                 style="width: 24px; height: 24px; border-radius: 50%;">
            Dashboard
        `;
        loginBtn.href = '/dashboard';
    }
}

// Animate stats counter
function animateStats() {
    const stats = document.querySelectorAll('.stat-value');
    stats.forEach(stat => {
        const target = stat.textContent;
        const numericTarget = parseInt(target.replace(/\D/g, ''));
        const suffix = target.replace(/[\d.]/g, '');
        
        let current = 0;
        const increment = numericTarget / 50;
        const timer = setInterval(() => {
            current += increment;
            if (current >= numericTarget) {
                current = numericTarget;
                clearInterval(timer);
            }
            stat.textContent = Math.floor(current) + suffix;
        }, 30);
    });
}

// ============================================================
// PLANS STATUS
// ============================================================

function formatSlotTime(ms) {
    if (!ms || ms <= 0) return 'Available';
    
    const totalMinutes = Math.floor(ms / 60000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;
    
    if (days > 0) {
        return `${days}d ${hours}h ${minutes}m`;
    } else if (hours > 0) {
        return `${hours}h ${minutes}m`;
    }
    return `${minutes}m`;
}

async function fetchSlotsStatus() {
    try {
        const response = await fetch('/api/slots-status');
        const data = await response.json();
        
        // Update totals
        const totalBrainrots = document.getElementById('totalBrainrots');
        const runningPercent = document.getElementById('runningPercent');
        
        if (totalBrainrots) {
            totalBrainrots.textContent = data.totalBrainrots.toLocaleString();
        }
        if (runningPercent) {
            runningPercent.textContent = data.runningPercent + '%';
        }
        
        // Render plan cards
        renderPlanStatusCards(data.plans);
    } catch (error) {
        console.log('Error fetching slots status:', error);
    }
}

function renderPlanStatusCards(plans) {
    const grid = document.getElementById('plansStatusGrid');
    if (!grid) return;
    
    const tierClasses = { 1: 'bronze', 2: 'silver', 3: 'gold', 4: 'diamond' };
    
    let html = '';
    for (const tier in plans) {
        const plan = plans[tier];
        const tierClass = tierClasses[tier];
        // Show: active users / max slots
        const displaySlots = `${plan.activeUsers}/${plan.maxSlots}`;
        // Bar = users / slots
        const percentage = (plan.activeUsers / plan.maxSlots) * 100;
        
        html += `
            <div class="plan-status-card ${tierClass}">
                <div class="plan-status-header">
                    <span class="plan-status-name">${plan.name.toUpperCase()}</span>
                    <span class="plan-status-slots">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/>
                            <circle cx="9" cy="7" r="4"/>
                            <path d="M23 21v-2a4 4 0 0 0-3-3.87"/>
                            <path d="M16 3.13a4 4 0 0 1 0 7.75"/>
                        </svg>
                        ${displaySlots}
                    </span>
                </div>
                <div class="plan-status-next">${plan.activeUsers > 0 ? `Next slot in: ${formatSlotTime(plan.nextSlotMs)}` : `${plan.slotsPerUser} slots/user`}</div>
                <div class="plan-status-bar">
                    <div class="plan-status-bar-fill" style="width: ${percentage}%"></div>
                </div>
            </div>
        `;
    }
    
    grid.innerHTML = html;
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    // Connect to real-time logs
    connectToLogs();
    checkAuth();
    
    // Fetch slots status
    fetchSlotsStatus();
    setInterval(fetchSlotsStatus, 30000); // Update every 30 seconds
    
    // Update log times every 30 seconds
    setInterval(updateLogTimes, 30000);
    
    // Animate stats when in view
    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                animateStats();
                observer.disconnect();
            }
        });
    });
    
    const statsSection = document.querySelector('.hero-stats');
    if (statsSection) {
        observer.observe(statsSection);
    }
});

// Smooth scroll for anchor links
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
    });
});
