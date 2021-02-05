/* jshint node: true */
'use strict';

const ZclId = require('zcl-id');

var zApp,
    foundApis = {};

foundApis.read = async function (clusters, cId, payload, afMsg) {
    const ret = []

    for(const readRec of payload){
        let attrId = readRec.attrId,
            attrType = ZclId.attrType(cId, attrId).key,
            rptCfg,
            readStatusRec = {
                attrId: attrId,
                status: null
            };

        try {
            const data = await clusters.read(cId, attrId)
            readStatusRec.status = ZclId.status('success').value;
            readStatusRec.dataType = ZclId.attrType(cId, attrId).value;
            readStatusRec.attrData = data;

            if (isAnalog(attrType) && clusters.has(cId, 'rptCfgs', attrId)) {
                rptCfg = clusters.get(cId, 'rptCfgs', attrId);
                let lastRpVal = rptCfg.lastRpVal;
                rptCfg.lastRpVal = data;
                clusters.set(cId, 'rptCfgs', attrId, rptCfg);

                if (rptCfg.pmax !== 0xffff && !isNaN(rptCfg.step) &&
                    Math.abs(data - lastRpVal) > rptCfg.step) {
                    zApp._report(cId, attrId, data, afMsg);
                }
            }
        } catch(err){
            if (err.code === '_notfound_')
                readStatusRec.status = ZclId.status('unsupAttribute').value;
            else if (err.code === '_unreadable_' || err.code === '_exec_')
                readStatusRec.status = ZclId.status('notAuthorized').value;
            else
                readStatusRec.status = ZclId.status('failure').value;
        }

        ret.push(readStatusRec)
    }

    return ret
}

foundApis.write = async function (clusters, cId, payload, afMsg) {
    const ret = []

    for(const writeRec of payload){
        let attrId = writeRec.attrId,
            attrType = ZclId.attrType(cId, attrId).key,
            rptCfg,
            acl = clusters.get(cId, 'attrs', attrId),
            writeStatusRec = {
                attrId: attrId,
                status: null
            };

        if (acl === 'R') {
            // do nothing particular
        } else if (writeRec.dataType !== ZclId.attrType(cId, attrId).value) {
            writeStatusRec.status = ZclId.status('invalidValue').value;
        } else {
            try {
                const data = await clusters.write(cId, attrId, writeRec.attrData)

                writeStatusRec.status = ZclId.status('success').value;

                if (clusters.has(cId, 'rptCfgs', attrId) && isAnalog(attrType)) {
                    rptCfg = clusters.get(cId, 'rptCfgs', attrId);
                    let lastRpVal = rptCfg.lastRpVal;
                    rptCfg.lastRpVal = data;
                    clusters.set(cId, 'rptCfgs', attrId, rptCfg);

                    if (rptCfg.pmax !== 0xffff &&
                        !isNaN(rptCfg.step) &&
                        Math.abs(data - lastRpVal) > rptCfg.step) {
                        await zApp._report(cId, attrId, data, afMsg);
                    }
                }
            } catch(err){
                if (err.code === '_notfound_')
                    writeStatusRec.status = ZclId.status('unsupAttribute').value;
                else if (err.code === '_unwritable_' || err.code === '_exec_')
                    writeStatusRec.status = ZclId.status('notAuthorized').value;
                else
                    writeStatusRec.status = ZclId.status('failure').value;
            }
        }
        ret.push(writeStatusRec)
    }

    return ret
};

foundApis.configReport = function (clusters, cId, payload, afMsg) {
    var cfgRptRsps = [];

    if (!clusters.has(cId, 'rptCfgs')) {
        clusters.zapp = null;
        clusters.init(cId, 'rptCfgs', {}, false);
        clusters.zapp = zApp;
    }

    for(const attrRptCfgRec of payload){
        let attrId = attrRptCfgRec.attrId,
            attrType = ZclId.attrType(cId, attrId).key,
            cfg = clusters.get(cId, 'rptCfgs', attrId),
            attrStatusRec = {
                attrId: attrId,
                direction: attrRptCfgRec.direction,
                status: null
            };

        if (!clusters.has(cId, 'attrs', attrId))
            attrStatusRec.status = ZclId.status('unsupAttribute').value;
        else if (attrType === 'array' || attrType === 'struct' || attrType === 'bag')
            attrStatusRec.status = ZclId.status('unsupAttribute').value;
        else if (attrStatusRec.direction === 1) {
            if (!cfg) cfg = {};

            cfg.timeout = attrRptCfgRec.timeout;
            clusters.set(cId, 'rptCfgs', attrId, cfg);
            attrStatusRec.status = ZclId.status('success').value;
        } else {
            if (attrRptCfgRec.dataType !== ZclId.attrType(cId, attrId).value)
                attrStatusRec.status = ZclId.status('invalidDataType').value;
            else {
                if (!cfg) cfg = {};
                if (!cfg.rRpt) cfg.rRpt = {};

                cfg.pmin = attrRptCfgRec.minRepIntval;
                cfg.pmax = attrRptCfgRec.maxRepIntval;
                cfg.step = isAnalog(attrType) ? attrRptCfgRec.repChange : null;

                // clear old report config
                if (cfg.rRpt.min) {
                    clearTimeout(cfg.rRpt.min);
                    cfg.rRpt.min = null;
                }

                if (cfg.rRpt.max) {
                    clearInterval(cfg.rRpt.max);
                    cfg.rRpt.max = null;
                }

                // set up new report config
                if (cfg.pmax !== 0xffff) {
                    cfg.rRpt.min = setTimeout(async function () {
                        if (cfg.pmin !== 0) {
                            const data = await clusters.read(cId, attrId);
                            cfg.lastRpVal = data;
                            zApp._report(cId, attrId, data, afMsg);
                        }
                    }, cfg.pmin * 1000);

                    cfg.rRpt.max = setInterval(async function () {
                        const data = await clusters.read(cId, attrId)
                        
                        cfg.lastRpVal = data;
                        zApp._report(cId, attrId, data, afMsg);

                        if (!cfg.rRpt.min)
                            clearTimeout(cfg.rRpt.min);

                        cfg.rRpt.min = null;

                        cfg.rRpt.min = setTimeout(async function () {
                            if (cfg.pmin !== 0) {
                                const data = await clusters.read(cId, attrId);
                                cfg.lastRpVal = data;
                                zApp._report(cId, attrId, data, afMsg);
                            }
                        }, cfg.pmin * 1000);
                    }, cfg.pmax * 1000);
                }

                clusters.set(cId, 'rptCfgs', attrId, cfg);
                attrStatusRec.status = ZclId.status('success').value;
            }
        } 
        cfgRptRsps.push(attrStatusRec);
    }
    return cfgRptRsps
};

foundApis.readReportConfig = function (clusters, cId, payload, _afMsg) {
    var readCfgRptRsps = [];

    for(const attrRec of payload){
        let attrId = attrRec.attrId,
            attrType = ZclId.attrType(cId, attrId).value,
            direction = attrRec.direction,
            cfg = clusters.get(cId, 'rptCfgs', attrId),
            attrRptCfgRec = {
                attrId: attrId,
                direction: direction,
                status: null
            };

        if (!clusters.has(cId, 'attrs', attrId))
            attrRptCfgRec.status = ZclId.status('unsupAttribute').value;
        else if (!cfg)
            attrRptCfgRec.status = ZclId.status('unreportableAttribute').value;
        else if (direction === 1) {
            attrRptCfgRec.status = ZclId.status('success').value;
            attrRptCfgRec.timeout = cfg.timeout ? cfg.timeout : 0xffff;
        } else {
            attrRptCfgRec.status = ZclId.status('success').value;
            attrRptCfgRec.dataType = attrType;
            attrRptCfgRec.minRepIntval = cfg.pmin ? cfg.pmin : 0xffff;
            attrRptCfgRec.maxRepIntval = cfg.pmax ? cfg.pmax : 0xffff;
            if (isAnalog(attrType))
                attrRptCfgRec.repChange = cfg.step ? cfg.step : 0;
        }
        readCfgRptRsps.push(attrRptCfgRec);
    }
    return readCfgRptRsps
};

foundApis.discover = function (clusters, cId, payload, _afMsg) {
    var attrs = clusters.dumpSync(cId, 'attrs'),
        startId = payload.startAttrId,
        maxNums = payload.maxAttrIds,
        discRsp = {
            discComplete: 1,
            attrInfos: []
        };

    for(const id in attrs){
        var attrId = ZclId.attr(cId, id).value,
            attrInfo = {
                attrId: attrId,
                dataType: null
            };

        if (discRsp.attrInfos.length >= maxNums)
            return false;

        if (attrId >= startId) {
            attrInfo.dataType = ZclId.attrType(cId, attrId).value;
            discRsp.attrInfos.push(attrInfo);
        }
    }
    return discRsp
};

function isAnalog(dataType) {
    var type = ZclId.dataType(dataType).value,
        analogDigital;

    if ((type > 0x07 && type < 0x20) ||  //GENERAL_DATA, LOGICAL, BITMAP
        (type > 0x2f && type < 0x38) ||  //ENUM
        (type > 0x3f && type < 0x58) ||  //STRING, ORDER_SEQ, COLLECTION
        (type > 0xe7 && type < 0xff))    //IDENTIFIER, MISC
    {
        analogDigital = false;
    } else if (
        (type > 0x1f && type < 0x30) ||  //UNSIGNED_INT, SIGNED_INT
        (type > 0x37 && type < 0x40) ||  //FLOAT
        (type > 0xdf && type < 0xe8))    //TIME
    {
        analogDigital = true;
    }

    return analogDigital;
}

module.exports = function(zive) {
    zApp = zive;
    return foundApis;
};
