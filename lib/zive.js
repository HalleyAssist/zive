/* jshint node: true */
'use strict';

var ZclId = require('zcl-id'),
    foundApis = require('./foundation_apis');

/*************************************************************************************************/
/*** Zive Class                                                                                ***/
/*************************************************************************************************/
function Zive(infos, clusters) {
    this._simpleDesc = {
        profId: infos.profId,
        devId: infos.devId,
        inClusterList: [],
        outClusterList: []
    };

    this._endpoint = null;
    this._discCmds = infos.discCmds ? infos.discCmds : [];

    this._foundApis = foundApis(this);

    this.clusters = clusters;
    this.clusters.glue(this);

    const dumpedClusters = clusters.dumpSync()
    for(const cId in dumpedClusters){
        const cInfo = dumpedClusters[cId]

        if (cInfo.dir.value & 1)
            this._simpleDesc.inClusterList.push(ZclId.cluster(cId).value);
        if (cInfo.dir.value & 2)
            this._simpleDesc.outClusterList.push(ZclId.cluster(cId).value);
    }
}

Zive.prototype.foundationHandler = function (msg) {
    var clusters = this.clusters,
        data = msg.zclMsg,
        cId = msg.clusterid,
        cmdName = ZclId.foundation(data.cmdId).key,
        cfg = {
            manufSpec: data.frameCntl.manufSpec,
            direction: 1,
            disDefaultRsp: data.frameCntl.disDefaultRsp,
            seqNum: data.seqNum
        },
        cmdRsp;

    cmdName = (cmdName === 'writeUndiv') ? 'write' : cmdName;

    switch (cmdName) {
        case 'read':
        case 'configReport':
        case 'readReportConfig':
        case 'discover':
        case 'write':
            cmdRsp = cmdName + 'Rsp';
            break;
        case 'writeNoRsp':
            this._foundApis.write(clusters, cId, data.payload, msg, function () {});
            break;
        case 'readStruct':
        case 'writeStrcut':
            // not support now
            break;
        default:
            break;
    }

    if (cmdRsp)
        this._foundApis[cmdName](clusters, cId, data.payload, msg, (_err, result) => {
            this.foundation(null, msg.srcaddr, msg.srcendpoint, cId, cmdRsp, result, cfg);
        });
};

Zive.prototype.functionalHandler = async function (msg, remoteEp) {
    var data = msg.zclMsg,
        cId = msg.clusterid,
        cmdId = data.cmdId,
        cmdDir = data.frameCntl.direction,
        defaultRsp = data.frameCntl.disDefaultRsp,
        cfg = {
            manufSpec: data.frameCntl.manufSpec,
            direction: cmdDir ? 0 : 1,
            disDefaultRsp: defaultRsp,
            seqNum: data.seqNum
        },
        payload = {
            cmdId: cmdId,
            statusCode: null
        },
        cmdType,
        cmdName,
        cmdRspId,
        cmdRspName;

    cmdType = cmdDir ? 'cmdRsp' : 'cmd';    // 0: client-to-server('cmd'), 1: server-to-client('cmdRsp')
    cmdName = ZclId[cmdDir ? 'getCmdRsp' : 'functional'](cId, cmdId).key;
    cmdRspId = ZclId[cmdDir ? 'functional' : 'getCmdRsp'](cId, cmdName + 'Rsp');
    cmdRspName = cmdRspId ? cmdRspId.key : null;

    if (typeof data.payload === 'object') {
        var srcInfo = {
            epId: null,
            ieeeAddr: '',
            nwkAddr: null
        };

        if (typeof remoteEp === 'object') {
            srcInfo.epId = remoteEp.getEpId();
            srcInfo.ieeeAddr = remoteEp.getIeeeAddr();
            srcInfo.nwkAddr = remoteEp.getNwkAddr();
        }

        data.payload.src = srcInfo;
        data.payload._cfg =  {
            manufSpec: data.frameCntl.manufSpec,
            direction: cmdDir,
            disDefaultRsp: defaultRsp,
            seqNum: data.seqNum
        }
    }

    const defaultCfg = Object.assign({disDefaultRsp: 1, response: true}, cfg)

    let rspData
    try {
        rspData = await this.clusters.exec(cmdType, cId, cmdName, data.payload)
    } catch(err){
        if(err.code == '_notfound_'){
            payload.statusCode = ZclId.status('unsupClusterCmd').value;
        }else{
            payload.statusCode = ZclId.status('failure').value;
        }
        await this.foundation(null, msg.srcaddr, msg.srcendpoint, cId, 'defaultRsp', payload, defaultCfg)
        return
    }

    // Zive App handled response
    if(rspData === null){
        return
    }
    
    if (cmdRspName) {
        if (!rspData) {
            if (defaultRsp === 0) {
                payload.statusCode = ZclId.status('success').value;
                await this.foundation(null, msg.srcaddr, msg.srcendpoint, cId, 'defaultRsp', payload, defaultCfg)
            }
        } else {
            payload = rspData;
            await this.functional(null, msg.srcaddr, msg.srcendpoint, cId, cmdRspName, payload, cfg);
            // [TODO] if payload format error, throw error?
        }
    } else if (defaultRsp === 0) {
        payload.statusCode = ZclId.status('success').value;
        await this.foundation(null, msg.srcaddr, msg.srcendpoint, cId, 'defaultRsp', payload, defaultCfg)
    }
};

Zive.prototype._report = function (cId, attrId, data, afMsg) {
    var cfg = {
            manufSpec: afMsg.zclMsg.frameCntl.manufSpec,
            direction: 1,
            disDefaultRsp: afMsg.zclMsg.frameCntl.disDefaultRsp
        },
        attrReport = {
            attrId: attrId,
            dataType: ZclId.attrType(cId, attrId).value,
            attrData: null
        };

    attrReport.attrData = data;
    this.foundation(null, afMsg.srcaddr, afMsg.srcendpoint, cId, 'report', attrReport, cfg);
};

Zive.prototype.isZive = ()=>true

module.exports = Zive;
