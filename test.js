const ZKLib = require('./zklib')

const test = async () => {
    let zkInstance = new ZKLib('10.38.62.29', 4370, 5200, 5000);

    try {
        await zkInstance.createSocket();
        console.log(await zkInstance.getInfo());
        
        // const users = await zkInstance.getUsers();
        // console.log(users);

        const attendences = await zkInstance.getAttendances();
        console.log(attendences);
    } catch (err) {
        console.error("❌ Error:", err);
    } finally {
        await zkInstance.disconnect(); // always good to close connection
        console.log("🔌 Disconnected from device");
    }
}

test();
