require('dotenv').config();
import * as asyncLib from 'async';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import {
  IArchivesLog,
  IRecentACSubmissions,
  IRecentACSubmissionsResponse,
  IUser,
} from './typings';

const users = require('../dict/user.json');
const lcusAllQuestionsMap = require('../dict/lcus_all_questions_map.json');
const dayjs = require('dayjs');
// 日期格式化方式
const DATE_FORMAT_STRING = 'YYYY-MM-DD';
// 当天日期
const today = dayjs().format(DATE_FORMAT_STRING);
const yesterday = dayjs().subtract(1, 'day').format(DATE_FORMAT_STRING);

// 由于 GitHub Actions 定时器启动不准，这里做下兼容处理
// 定时器不会延迟太久，所以这里仅判断跨天的的即可 
// 如果启动时间在凌晨 00:30 以内的话，就查询昨天记录
let queryDate = today;
if (new Date().getHours() === 0 && new Date().getMinutes() < 30) {
  queryDate = yesterday;
}

/**
 * 判断文件是否存在
 * @param {string} path 文件路径
 * @returns {Promise<boolean>} 是否存在
 */
const isFileExists = async (path: string): Promise<boolean> => {
  return new Promise(function (resolve, reject) {
    fs.stat(path, (err) => {
      if (err) {
        resolve(false);
      } else {
        resolve(true);
      }
    });
  });
};

/**
 * Axios请求
 * @param user 用户信息
 * @returns
 */
const lcQuery = async (user: IUser) => {
  let url = user.lcus
    ? 'https://leetcode.com/graphql/'
    : 'https://leetcode-cn.com/graphql/noj-go/';
  let graphqlQuery = user.lcus
    ? {
        query:
          '\n    query recentAcSubmissions($username: String!, $limit: Int!) {\n  recentAcSubmissionList(username: $username, limit: $limit) {\n    id\n    title\n    titleSlug\n    timestamp\n  }\n}\n    ',
        variables: { username: user.userId, limit: 50 },
      }
    : {
        query:
          '\n    query recentACSubmissions($userSlug: String!) {\n  recentACSubmissions(userSlug: $userSlug) {\n    submissionId\n    submitTime\n    question {\n      translatedTitle\n      titleSlug\n      questionFrontendId\n    }\n  }\n}\n    ',
        variables: { userSlug: user.userId },
      };
  const options = {
    //Method is post because we are requesting from graphql
    method: 'POST',
    url,
    headers: {
      'x-csrftoken': process.env.CSRFTOKEN as string,
    },
    data: graphqlQuery,
  };

  try {
    const response = await axios.request<{
      code: number;
      data: IRecentACSubmissionsResponse;
    }>(options);

    // 抹平国服和美服的差异
    const { recentACSubmissions, recentAcSubmissionList } = response.data.data;
    const result: IRecentACSubmissions[] = [];

    if (user.lcus) {
      // 美服
      recentAcSubmissionList.forEach((el) => {
        result.push({
          // 从映射中获取美服问题的ID
          questionFrontendId:
            lcusAllQuestionsMap[el.titleSlug]?.questionId || el.titleSlug,
          titleSlug: el.titleSlug,
          submitTime: +el.timestamp * 1000,
        });
      });
    } else {
      // 国服
      recentACSubmissions.forEach((el) => {
        result.push({
          questionFrontendId: el.question.questionFrontendId,
          titleSlug: el.question.titleSlug,
          submitTime: el.submitTime * 1000,
        });
      });
    }

    return result;
  } catch (err) {
    throw err;
  }
};

/**
 * 获取用户某一天的的提交记录
 * @param userInfo 用户信息
 * @param callback mapLimit 并发队列的回调函数
 * @param date 统计哪一天的提交
 * @description 利用最近 15 道 AC 的题目的接口，过滤后获得结果，最好是统计最近1~2天
 */
const getTodayAcSubmissions = async (
  userInfo: IUser,
  callback: asyncLib.AsyncResultArrayCallback<any>,
  date: string = today
) => {
  const { userName, userId, lcus = false } = userInfo;
  const filePath = path.resolve(
    __dirname,
    `../archives/${userName}(${userId}).json`
  );
  // 检查是是否有用户的文件
  const exists = await isFileExists(filePath);
  if (!exists) {
    // 创建文件
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        userName,
        userId,
        homepage: lcus
          ? `https://leetcode.com/u/${userId}/`
          : `https://leetcode-cn.com/u/${userId}/`,
        logs: [],
      }),
      {
        encoding: 'utf8',
      }
    );
  }

  try {
    const recentACSubmissions = await lcQuery(userInfo);

    const todayACQuestionIds = recentACSubmissions
      .filter(
        (row) => dayjs(row.submitTime).format(DATE_FORMAT_STRING) === date
      )
      .map((row) => `[${row.questionFrontendId}]`);

    // 去重
    const uniqeQuestionIds = Array.from(new Set(todayACQuestionIds));

    // 读取 json 文件
    const archivesData: IArchivesLog = JSON.parse(
      fs.readFileSync(filePath, 'utf8')
    );
    // 记录更新时间
    archivesData.updatedAt = dayjs().format();
    // 查找当天之外的所有的题目
    const historyLogs = archivesData.logs.find((log) => log.date !== date);
    // 当天的记录
    const targetLog = archivesData.logs.find((log) => log.date === date);

    const historyQuestionIds = [
      ...(historyLogs?.questionIds || []),
      ...(historyLogs?.review || []),
    ];
    // 新问题
    const questionIds: string[] = [];
    // 复习的问题
    const reviewIds: string[] = [];
    uniqeQuestionIds.forEach((questionId) => {
      // 判断是否是历史出现过的题目
      if (historyQuestionIds.includes(questionId)) {
        reviewIds.push(questionId);
      } else {
        questionIds.push(questionId);
      }
    });

    if (!targetLog) {
      archivesData.logs.push({
        date,
        questionIds,
        review: reviewIds,
      });
    } else {
      // 保存时去重一次
      targetLog.questionIds = Array.from(
        new Set([...targetLog.questionIds, ...questionIds])
      );
      targetLog.review = Array.from(
        new Set([...(targetLog.review || []), ...reviewIds])
      );
    }

    // 针对日期排序，最近的日期在上面
    archivesData.logs.sort((a, b) => +new Date(b.date) - +new Date(a.date));

    // 如果为空，有2种可能，
    // 1是确实是没有提交题目
    // 2是设置了隐保护，需要去 [通知与隐私 - 隐私设置 - 显示我的提交记录] 开启
    fs.writeFileSync(filePath, JSON.stringify(archivesData), {
      encoding: 'utf8',
    });
  } catch (err: any) {
    console.error(
      `用户 [${userId}] 统计失败。可以手动前往用户主页查看 https://leetcode-cn.com/u/${userId}/`
    );
  } finally {
    console.log(`用户 [${userId}] --- ok`);
    callback(null);
  }
};

asyncLib.mapLimit<IUser, any, any>(
  users,
  5,
  async function (userInfo, callback) {
    await getTodayAcSubmissions(userInfo, callback, queryDate);
  },
  (err, results) => {
    if (err) throw err;
    console.log('全部处理完成^_^');
  }
);
