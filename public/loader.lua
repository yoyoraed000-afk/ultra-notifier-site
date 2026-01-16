--[[
    Ultra Notifier - Secure Loader
    This is safe to be public - it only loads the scanner from your secure server
]]

local Players = game:GetService("Players")
local LocalPlayer = Players.LocalPlayer

-- Get key from getgenv()
local KEY = getgenv().LICENSE_KEY
if not KEY or KEY == "" then
    warn("[Ultra Notifier] ❌ ERROR: Set your license key first!")
    warn("Example: getgenv().LICENSE_KEY = 'YOUR-KEY-HERE'")
    warn("Get your key at: https://ultranotifier.live/dashboard")
    return
end

-- Get HWID
local function getHWID()
    local hwid = ""
    pcall(function()
        if gethwid then
            hwid = gethwid()
        elseif get_hwid then
            hwid = get_hwid()
        elseif identifyexecutor then
            hwid = identifyexecutor() .. "_" .. game:GetService("RbxAnalyticsService"):GetClientId()
        else
            hwid = game:GetService("RbxAnalyticsService"):GetClientId()
        end
    end)
    return hwid
end

-- Get Roblox username
local robloxUsername = LocalPlayer and LocalPlayer.Name or "Unknown"
local hwid = getHWID()

print("==========================================")
print("[Ultra Notifier] Loading scanner...")
print("[Ultra Notifier] User: " .. robloxUsername)
print("==========================================")

-- Build URL with all params
local url = "https://ultranotifier.live/api/scanner/script?key=" .. KEY
url = url .. "&roblox_username=" .. robloxUsername
if hwid ~= "" then
    url = url .. "&hwid=" .. hwid
end

-- Load scanner from secure server (requires valid key)
local success, result = pcall(function()
    return game:HttpGet(url)
end)

if not success or not result then
    warn("[Ultra Notifier] ❌ Failed to connect to server")
    return
end

-- Check for error messages
if result:sub(1, 8) == "-- ERROR" then
    warn("[Ultra Notifier] " .. result)
    return
end

print("[Ultra Notifier] ✅ Scanner loaded!")
print("==========================================")

-- Execute the scanner
loadstring(result)()
