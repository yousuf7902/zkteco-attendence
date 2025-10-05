const net = require('net')
const { MAX_CHUNK, COMMANDS, REQUEST_DATA } = require('./constants')
const timeParser = require('./timestamp_parser');
const { createTCPHeader,
  exportErrorMessage,
  removeTcpHeader,
  decodeUserData72,
  decodeRecordData40,
  decodeRecordRealTimeLog52,
  checkNotEventTCP,
  decodeTCPHeader,
  makeCommKey} = require('./utils')

const { log } = require('./helpers/errorLog');
const { ZKError } = require('./zkerror');

class ZKLibTCP {
  is_connect = false;

  constructor(ip, port = 4370, timeout = 10000, comm_code = undefined, encoding = 'UTF-8') {
    this.ip = ip
    this.port = port
    this.timeout = timeout
    this.sessionId = null
    this.replyId = 0
    this.socket = null
    this.comm_code = comm_code
    this.encoding = encoding
  }


  createSocket(cbError, cbClose) {
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket()

      this.socket.once('error', err => {
        reject(err)
        cbError && cbError(err)
      })

      this.socket.once('connect', () => {
        resolve(this.socket)
      })

      this.socket.once('close', (err) => {
        this.socket = null;
        cbClose && cbClose('tcp')
      })


      if (this.timeout) {
        this.socket.setTimeout(this.timeout)
      }

      this.socket.connect(this.port, this.ip)
    })
  }


  connect() {
    return new Promise(async (resolve, reject) => {
      try {
        let reply = await this.executeCmd(COMMANDS.CMD_CONNECT, '')

        if (reply.readUInt16LE(0) === COMMANDS.CMD_ACK_OK) {
          resolve(true)
        }
        if (reply.readUInt16LE(0) === COMMANDS.CMD_ACK_UNAUTH) {
          const hashedCommkey = makeCommKey(this.comm_code, this.sessionId)
          reply = await this.executeCmd(COMMANDS.CMD_AUTH, hashedCommkey)
          
          if (reply.readUInt16LE(0) === COMMANDS.CMD_ACK_OK) {
            resolve(true)
          } else {
            reject(new Error("error de authenticacion", responseCMD))
          }
        } else {

          reject(new Error('NO_REPLY_ON_CMD_CONNECT'))
        }
      } catch (err) {
        reject(err)
      }
    })
  }


  closeSocket() {
    return new Promise((resolve, reject) => {
      this.socket.removeAllListeners('data')
      this.socket.end(() => {
        clearTimeout(timer)
        resolve(true)
      })
      /**
       * When socket isn't connected so this.socket.end will never resolve
       * we use settimeout for handling this case
       */
      const timer = setTimeout(() => {
        resolve(true)
      }, 2000)
    })
  }

  writeMessage(msg, connect) {
    return new Promise((resolve, reject) => {
      let timer = null;
      this.socket.once("data", (data) => {
        timer && clearTimeout(timer);
        resolve(data);
      });

      this.socket.write(msg, null, async (err) => {
        if (err) {
          reject(err);
        } else if (this.timeout) {
          timer = await setTimeout(
            () => {
              clearTimeout(timer);
              reject(new Error("TIMEOUT_ON_WRITING_MESSAGE"));
            },
            connect ? 2000 : this.timeout
          );
        }
      });
    });
  }

  requestData(msg) {
    return new Promise((resolve, reject) => {
      let timer = null;
      let replyBuffer = Buffer.from([]);
      const internalCallback = (data) => {
        this.socket.removeListener("data", handleOnData);
        timer && clearTimeout(timer);
        resolve(data);
      };

      const handleOnData = (data) => {
        replyBuffer = Buffer.concat([replyBuffer, data]);
        if (checkNotEventTCP(data)) return;
        clearTimeout(timer);
        const header = decodeTCPHeader(replyBuffer.subarray(0, 16));

        if (header.commandId === COMMANDS.CMD_DATA) {
          timer = setTimeout(() => {
            internalCallback(replyBuffer);
          }, 1000);
        } else {
          timer = setTimeout(() => {
            reject(new Error("TIMEOUT_ON_RECEIVING_REQUEST_DATA"));
          }, this.timeout);

          const packetLength = data.readUIntLE(4, 2);
          if (packetLength > 8) {
            internalCallback(data);
          }
        }
      };

      this.socket.on("data", handleOnData);

      this.socket.write(msg, null, (err) => {
        if (err) {
          reject(err);
        }

        timer = setTimeout(() => {
          reject(Error("TIMEOUT_IN_RECEIVING_RESPONSE_AFTER_REQUESTING_DATA"));
        }, this.timeout);
      });
    }).catch(function () {
      console.log("Promise Rejected");
    });
  }

  /**
   *
   * @param {*} command
   * @param {*} data
   *
   *
   * reject error when command fail and resolve data when success
   */

  executeCmd(command, data) {
    return new Promise(async (resolve, reject) => {
      if (command === COMMANDS.CMD_CONNECT) {
        this.sessionId = 0;
        this.replyId = 0;
      } else {
        this.replyId++;
      }
      const buf = createTCPHeader(command, this.sessionId, this.replyId, data);
      let reply = null;

      try {
        reply = await this.writeMessage(
          buf,
          command === COMMANDS.CMD_CONNECT || command === COMMANDS.CMD_EXIT
        );

        const rReply = removeTcpHeader(reply);
        if (rReply && rReply.length && rReply.length >= 0) {
          if (command === COMMANDS.CMD_CONNECT) {
            this.sessionId = rReply.readUInt16LE(4);
          }
        }
        resolve(rReply);
      } catch (err) {
        reject(err);
      }
    });
  }

  sendChunkRequest(start, size) {
    this.replyId++;
    const reqData = Buffer.alloc(8);
    reqData.writeUInt32LE(start, 0);
    reqData.writeUInt32LE(size, 4);
    const buf = createTCPHeader(
      COMMANDS.CMD_DATA_RDY,
      this.sessionId,
      this.replyId,
      reqData
    );

    this.socket.write(buf, null, (err) => {
      if (err) {
        log(`[TCP][SEND_CHUNK_REQUEST]` + err.toString());
      }
    });
  }

  /**
   *
   * @param {*} reqData - indicate the type of data that need to receive ( user or attLog)
   * @param {*} cb - callback is triggered when receiving packets
   *
   * readWithBuffer will reject error if it'wrong when starting request data
   * readWithBuffer will return { data: replyData , err: Error } when receiving requested data
   */
  readWithBuffer(reqData, cb = null) {
    return new Promise(async (resolve, reject) => {
      this.replyId++;
      const buf = createTCPHeader(
        COMMANDS.CMD_DATA_WRRQ,
        this.sessionId,
        this.replyId,
        reqData
      );
      let reply = null;

      try {
        reply = await this.requestData(buf);
        //console.log(reply.toString('hex'));
      } catch (err) {
        reject(err);
        console.log(reply);
      }

      const header = decodeTCPHeader(reply.subarray(0, 16));
      switch (header.commandId) {
        case COMMANDS.CMD_DATA: {
          resolve({ data: reply.subarray(16), mode: 8 });
          break;
        }
        case COMMANDS.CMD_ACK_OK:
        case COMMANDS.CMD_PREPARE_DATA: {
          // this case show that data is prepared => send command to get these data
          // reply variable includes information about the size of following data
          const recvData = reply.subarray(16);
          const size = recvData.readUIntLE(1, 4);

          // We need to split the data to many chunks to receive , because it's to large
          // After receiving all chunk data , we concat it to TotalBuffer variable , that 's the data we want
          let remain = size % MAX_CHUNK;
          let numberChunks = Math.round(size - remain) / MAX_CHUNK;
          let totalPackets = numberChunks + (remain > 0 ? 1 : 0);
          let replyData = Buffer.from([]);

          let totalBuffer = Buffer.from([]);
          let realTotalBuffer = Buffer.from([]);

          const timeout = 10000;
          let timer = setTimeout(() => {
            internalCallback(
              replyData,
              new Error("TIMEOUT WHEN RECEIVING PACKET")
            );
          }, timeout);

          const internalCallback = (replyData, err = null) => {
            // this.socket && this.socket.removeListener('data', handleOnData)
            timer && clearTimeout(timer);
            resolve({ data: replyData, err });
          };

          const handleOnData = (reply) => {
            if (checkNotEventTCP(reply)) return;
            clearTimeout(timer);
            timer = setTimeout(() => {
              internalCallback(
                replyData,
                new Error(`TIME OUT !! ${totalPackets} PACKETS REMAIN !`)
              );
            }, timeout);

            totalBuffer = Buffer.concat([totalBuffer, reply]);
            const packetLength = totalBuffer.readUIntLE(4, 2);
            if (totalBuffer.length >= 8 + packetLength) {
              realTotalBuffer = Buffer.concat([
                realTotalBuffer,
                totalBuffer.subarray(16, 8 + packetLength),
              ]);
              totalBuffer = totalBuffer.subarray(8 + packetLength);

              if (
                (totalPackets > 1 &&
                  realTotalBuffer.length === MAX_CHUNK + 8) ||
                (totalPackets === 1 && realTotalBuffer.length === remain + 8)
              ) {
                replyData = Buffer.concat([
                  replyData,
                  realTotalBuffer.subarray(8),
                ]);
                totalBuffer = Buffer.from([]);
                realTotalBuffer = Buffer.from([]);

                totalPackets -= 1;
                cb && cb(replyData.length, size);

                if (totalPackets <= 0) {
                  internalCallback(replyData);
                }
              }
            }
          };

          this.socket.once("close", () => {
            internalCallback(
              replyData,
              new Error("Socket is disconnected unexpectedly")
            );
          });

          this.socket.on("data", handleOnData);

          for (let i = 0; i <= numberChunks; i++) {
            if (i === numberChunks) {
              this.sendChunkRequest(numberChunks * MAX_CHUNK, remain);
            } else {
              this.sendChunkRequest(i * MAX_CHUNK, MAX_CHUNK);
            }
          }

          break;
        }
        default: {
          reject(
            new Error(
              "ERROR_IN_UNHANDLE_CMD " + exportErrorMessage(header.commandId)
            )
          );
        }
      }
    });
  }

  async getSmallAttendanceLogs() {}

  /**
   *  reject error when starting request data
   *  return { data: users, err: Error } when receiving requested data
   */
  async getUsers() {
    // Free Buffer Data to request Data
    if (this.socket) {
      try {
        await this.freeData();
      } catch (err) {
        return Promise.reject(err);
      }
    }

    let data = null;
    try {
      data = await this.readWithBuffer(REQUEST_DATA.GET_USERS);
    } catch (err) {
      return Promise.reject(err);
    }

    // Free Buffer Data after requesting data
    if (this.socket) {
      try {
        await this.freeData();
      } catch (err) {
        return Promise.reject(err);
      }
    }

    const USER_PACKET_SIZE = 72;

    let userData = data.data.subarray(4);

    let users = [];

    while (userData.length >= USER_PACKET_SIZE) {
      const user = decodeUserData72(userData.subarray(0, USER_PACKET_SIZE));
      users.push(user);
      userData = userData.subarray(USER_PACKET_SIZE);
    }

    return { data: users };
  }

  /**
   *
   * @param {*} ip
   * @param {*} callbackInProcess
   *  reject error when starting request data
   *  return { data: records, err: Error } when receiving requested data
   */

  async getAttendances(callbackInProcess = () => {}) {
    if (this.socket) {
      try {
        await this.freeData();
      } catch (err) {
        return Promise.reject(err);
      }
    }

    let data = null;
    try {
      data = await this.readWithBuffer(
        REQUEST_DATA.GET_ATTENDANCE_LOGS,
        callbackInProcess
      );
    } catch (err) {
      return Promise.reject(err);
    }

    if (this.socket) {
      try {
        await this.freeData();
      } catch (err) {
        return Promise.reject(err);
      }
    }

    
    // const RECORD_PACKET_SIZE = 40
    // let recordData = data.data.subarray(4)
    // let records = []
    // while (recordData.length >= RECORD_PACKET_SIZE) {
    //   const record = decodeRecordData72(recordData.subarray(0, RECORD_PACKET_SIZE))
    //   records.push({ ...record, ip: this.ip })
    //   recordData = recordData.subarray(RECORD_PACKET_SIZE)
    // }


    //Sliding window implement for mixed buffers
    const RECORD_PACKET_SIZE = 40;
    const buf = data.data || Buffer.from([]);
    const records = [];
    const seen = new Set();
    let i = 0;

    while (i + RECORD_PACKET_SIZE <= buf.length) {
      try {
        // take a 40-byte candidate window
        const rawData = buf.subarray(i, i + RECORD_PACKET_SIZE);
        // decode with your existing decoder
        const record = decodeRecordData40(rawData);

        // Basic validation:
        // - deviceUserId should be a non-empty string of digits (or at least non-empty)
        // - recordTime should parse to a reasonable year (avoid year 2000 default / far future garbage)

        const id = record.userEnroll
          ? String(record.userEnroll).trim()
          : "";
        const dt = new Date(record.recordTime);
        const year = dt.getFullYear && dt.getFullYear();

        const isValidId = id.length > 0 && /^[0-9]+$/.test(id);
        const isValidYear = !Number.isNaN(year) && year >= 2005 && year <= 2035;

        if (isValidId && isValidYear) {
          const key = `${id}|${dt.toISOString()}`;

          if (!seen.has(key)) {
            seen.add(key);
            records.push({ ...record, ip: this.ip });
          }

          // jump ahead (we found a valid record at i, skip to next block after this record)
          i += RECORD_PACKET_SIZE;
          continue;
        }
      } catch (e) {
        // ignore decode errors for this offset and try next
      }

      // increase by 1 byte and try again (sliding window)
      i += 1;
    }

    return { data: records };
  }

  async freeData() {
    return await this.executeCmd(COMMANDS.CMD_FREE_DATA, "");
  }

  async disableDevice() {
    return await this.executeCmd(
      COMMANDS.CMD_DISABLEDEVICE,
      REQUEST_DATA.DISABLE_DEVICE
    );
  }

  async enableDevice() {
    return await this.executeCmd(COMMANDS.CMD_ENABLEDEVICE, "");
  }

  async disconnect() {
    try {
      await this.executeCmd(COMMANDS.CMD_EXIT, "");
    } catch (err) {}
    return await this.closeSocket();
  }

  async getInfo() {
    try {
      const data = await this.executeCmd(COMMANDS.CMD_GET_FREE_SIZES, "");

      return {
        userCounts: data.readUIntLE(24, 4),
        logCounts: data.readUIntLE(40, 4),
        logCapacity: data.readUIntLE(72, 4),
      };
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async getSerialNumber() {
    const keyword = "~SerialNumber";
    try {
      const data = await this.executeCmd(11, keyword);
      return data
        .slice(8)
        .toString("utf-8")
        .replace(keyword + "=", "");
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async getDeviceVersion() {
    const keyword = "~ZKFPVersion";
    try {
      const data = await this.executeCmd(COMMANDS.CMD_OPTIONS_RRQ, keyword);

      return data
        .slice(8)
        .toString("ascii")
        .replace(keyword + "=", "");
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async getDeviceName() {
    const keyword = "~DeviceName";
    try {
      const data = await this.executeCmd(COMMANDS.CMD_OPTIONS_RRQ, keyword);

      return data
        .slice(8)
        .toString("ascii")
        .replace(keyword + "=", "");
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async getPlatform() {
    const keyword = "~Platform";
    try {
      const data = await this.executeCmd(COMMANDS.CMD_OPTIONS_RRQ, keyword);

      return data
        .slice(8)
        .toString("ascii")
        .replace(keyword + "=", "");
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async getOS() {
    const keyword = "~OS";
    try {
      const data = await this.executeCmd(COMMANDS.CMD_OPTIONS_RRQ, keyword);

      return data
        .slice(8)
        .toString("ascii")
        .replace(keyword + "=", "");
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async getWorkCode() {
    const keyword = "WorkCode";
    try {
      const data = await this.executeCmd(COMMANDS.CMD_OPTIONS_RRQ, keyword);

      return data
        .slice(8)
        .toString("ascii")
        .replace(keyword + "=", "");
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async getPIN() {
    const keyword = "~PIN2Width";
    try {
      const data = await this.executeCmd(COMMANDS.CMD_OPTIONS_RRQ, keyword);

      return data
        .slice(8)
        .toString("ascii")
        .replace(keyword + "=", "");
    } catch (err) {
      return Promise.reject(err);
    }
  }
  async getFaceOn() {
    const keyword = "FaceFunOn";
    try {
      const data = await this.executeCmd(COMMANDS.CMD_OPTIONS_RRQ, keyword);
      if (
        data
          .slice(8)
          .toString("ascii")
          .replace(keyword + "=", "")
          .includes("0")
      )
        return "No";
      else return "Yes";
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async getSSR() {
    const keyword = "~SSR";
    try {
      const data = await this.executeCmd(COMMANDS.CMD_OPTIONS_RRQ, keyword);

      return data
        .slice(8)
        .toString("ascii")
        .replace(keyword + "=", "");
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async getFirmware() {
    try {
      const data = await this.executeCmd(1100, "");

      return data.slice(8).toString("ascii");
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async getTime() {
    try {
      const t = await this.executeCmd(COMMANDS.CMD_GET_TIME, "");
      return timeParser.decode(t.readUInt32LE(8));
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async setUser(uid, userid, name, password, role = 0, cardno = 0) {
    try {
      if (
        parseInt(uid) === 0 ||
        parseInt(uid) > 3000 ||
        userid.length > 9 ||
        name.length > 24 ||
        password.length > 8 ||
        cardno.length > 10
      ) {
        return false;
      }

      const command_string = Buffer.alloc(72);
      command_string.writeUInt16LE(uid, 0);
      command_string.writeUInt16LE(role, 2);
      command_string.write(password, 3, 8);
      command_string.write(name, 11, 24);
      command_string.writeUInt16LE(cardno, 35);
      command_string.writeUInt32LE(0, 40);
      command_string.write(userid ? userid.toString(9) : "", 48);

      //console.log(command_string);
      return await this.executeCmd(COMMANDS.CMD_USER_WRQ, command_string);
    } catch (e) {
      console.log(e);
      console.log("duh");
    }
  }

  async getAttendanceSize() {
    try {
      const data = await this.executeCmd(COMMANDS.CMD_GET_FREE_SIZES, "");
      return data.readUIntLE(40, 4);
    } catch (err) {
      return Promise.reject(err);
    }
  }

  async clearAttendanceLog() {
    return await this.executeCmd(COMMANDS.CMD_CLEAR_ATTLOG, "");
  }

  async getRealTimeLogs(cb = () => {}) {
    this.replyId++;

    try {
      const buf = createTCPHeader(COMMANDS.CMD_REG_EVENT, this.sessionId, this.replyId, Buffer.from([0x01, 0x00, 0x00, 0x00]))

      this.socket.write(buf, null, (err) => {});
      this.socket.listenerCount("data") === 0 &&
        this.socket.on("data", (data) => {
          if (!checkNotEventTCP(data)) return;
          if (data.length > 16) {
            cb(decodeRecordRealTimeLog52(data));
          }
        });
    } catch (err) {
      return Promise.reject(err);
    }

  }

}




module.exports = ZKLibTCP
