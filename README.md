# zkteco-attendence

A JavaScript library for interacting with ZK Time & Attendance devices.

### Overview

This library provides a simple and robust interface for communicating with ZKTeco biometric devices (fingerprint, face, card, and more) over TCP/UDP. It is designed to be compatible with a wide range of ZKTeco models and is based on [node-zklib](https://github.com/caobo171/node-zklib), with additional enhancements for reliability and compatibility.

> **Note:**  
> This package is a fork and extension of [node-zklib](https://github.com/caobo171/node-zklib).  
> It was created because I experienced issues fetching attendance logs from ZKTeco SpeedFace-V5L machines using the original package.  
> The `getAttendances` function has been **rewritten** for SpeedFace-V5L compatibility and reliability.

---

## Installation

```bash
npm i zkteco-attendence
```

---

## Usage

### Basic Example

```javascript
const ZKLib = require('zklib-js')

async function test() {
    let zkInstance = new ZKLib('192.168.1.201', 4370, 5200, 5000);
    
    try {
        // Create socket to machine
        await zkInstance.createSocket()
        
        // Get general info
        console.log(await zkInstance.getInfo())
        
        // Get users in machine
        const users = await zkInstance.getUsers()
        console.log(users)
        
        // Get attendance logs (SpeedFace-V5L compatible)
        const logs = await zkInstance.getAttendances()
        console.log(logs)
        
        // Disconnect
        await zkInstance.disconnect()
    } catch (e) {
        console.log(e)
    }
}

test()
```

---

### Available Functions

- `createSocket()`: Establish connection with the device
- `getInfo()`: Get general device information
- `getUsers()`: Retrieve users from the device
- `setUser(uid, userid, name, password, role = 0, cardno = 0)`: Create a new user
- `getAttendances(callback)`: Get all attendance logs (rewritten for SpeedFace-V5L)
- `getRealTimeLogs(callback)`: Get real-time logs
- `getTime()`: Get current time from the device
- `getSerialNumber()`: Get device serial number
- `getFirmware()`: Get firmware version
- `getPIN()`: Get device PIN
- `getFaceOn()`: Check if face recognition is enabled
- `getSSR()`: Get Self-Service-Recorder status
- `getDeviceVersion()`: Get device version
- `getDeviceName()`: Get device name
- `getPlatform()`: Get platform version
- `getOS()`: Get OS version
- `getWorkCode()`: Get work code
- `getAttendanceSize()`: Get attendance log size
- `clearAttendanceLog()`: Clear attendance logs
- `disconnect()`: Disconnect from the device

---

### Custom Commands

You can execute custom commands using the `executeCmd` function:

```javascript
async function executeCmd(command, data='') {
    return await this.functionWrapper(
        () => this.zklibTcp.executeCmd(command, data),
        () => this.zklibUdp.executeCmd(command, data)
    )
}

// Example: Unlock the door
zkInstance.executeCmd(CMD.CMD_UNLOCK, '')
```

For more commands, refer to the [ZK protocol documentation](https://github.com/adrobinoga/zk-protocol/blob/master/protocol.md).

---

## Why This Fork Exists

- The original [node-zklib](https://github.com/caobo171/node-zklib) library works well for many ZKTeco models.
- **SpeedFace-V5L and similar devices have a unique log record structure and firmware quirks**.
- The standard `getAttendances` function did not reliably return correct attendance logs for SpeedFace-V5L.
- This library **rewrites the attendance log parsing and filtering** to ensure you get accurate logs from SpeedFace-V5L (and most ZKTeco face devices).

---

## Credits

This library is based on:
- [node-zklib](https://github.com/caobo171/node-zklib) (main protocol implementation)
- [php_zklib](https://github.com/dnaextrim/php_zklib) (original PHP driver)
- [ZK protocol documentation](https://github.com/adrobinoga/zk-protocol)

---

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

---

## License

[MIT License](LICENSE)