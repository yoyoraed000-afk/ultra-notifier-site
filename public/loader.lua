--[[
    Ultra Notifier - Loader Script
    Validates your license key and loads the scanner
]]

local HttpService = game:GetService("HttpService")

-- CONFIGURATION
local API_URL = "https://ultranotifer.live"
local KEY = "YOUR_LICENSE_KEY_HERE" -- Users paste their key here

-- Get HWID (hardware identifier)
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
local function getRobloxUsername()
    local Players = game:GetService("Players")
    local player = Players.LocalPlayer
    return player and player.Name or "Unknown"
end

-- Validate license
local function validateLicense()
    local hwid = getHWID()
    local robloxUsername = getRobloxUsername()
    local url = API_URL .. "/api/validate?key=" .. KEY .. "&hwid=" .. hwid .. "&roblox_username=" .. robloxUsername
    
    local success, response = pcall(function()
        if syn and syn.request then
            return syn.request({ Url = url, Method = "GET" })
        elseif request then
            return request({ Url = url, Method = "GET" })
        elseif http_request then
            return http_request({ Url = url, Method = "GET" })
        end
    end)
    
    if not success or not response then
        return false, "Failed to connect to server"
    end
    
    local data = HttpService:JSONDecode(response.Body)
    return data.valid, data.error or data.plan, data.minValue, data.tier
end

-- Main
print("==========================================")
print("[Ultra Notifier] Validating license...")
print("==========================================")

local valid, message, minValue, tier = validateLicense()

if not valid then
    print("[Ultra Notifier] ❌ " .. (message or "Invalid license"))
    print("[Ultra Notifier] Get a license at: https://ultranotifer.live")
    return
end

print("[Ultra Notifier] ✅ License valid!")
print("[Ultra Notifier] Plan: " .. message)
print("[Ultra Notifier] Min Value: " .. (minValue and ("$" .. minValue) or "N/A"))
print("==========================================")

-- Set global config for the scanner
getgenv().ULTRA_NOTIFIER = {
    TIER = tier,
    MIN_VALUE = minValue or 0,
    PLAN = message
}

-- Load the actual scanner script
-- loadstring(game:HttpGet(API_URL .. "/scanner.lua"))()

print("[Ultra Notifier] Scanner loaded! Happy hunting! 🎃")

