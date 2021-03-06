'use strict';

/**
 * Provides service to work with gihub API.
 * http://developer.github.com/v3/
 */
angular.module('githubStarsApp')
  .factory('githubClient', ['$rootScope', '$http', '$cookies','$q', 'progressingPromise', 'cacheService', '$timeout', function ($rootScope, $http, $cookies, $q, progressingPromise, cacheService, $timeout) {
    var endpoint = 'https://api.github.com',
        isCaching = cacheService.isSupported && ($cookies.cacheEnabled === 'false' ? false : true),
        extractRateLimit = function (githubResponse) {
          var meta = githubResponse && githubResponse.data && githubResponse.data.meta;
          if (meta) {
            return {
              limit: parseInt(meta['X-RateLimit-Limit'], 10) || 0,
              remaining: parseInt(meta['X-RateLimit-Remaining'], 10) || 0
            };
          }
        },
        convertToQueryString = function (obj) {
          var queryString = [];
          for (var key in obj) {
            if (obj.hasOwnProperty(key)) {
              queryString.push(key + '=' + encodeURIComponent(obj[key]));
            }
          }
          return queryString.join('&');
        },

        /**
        * Makes single request to GitHub endpoint, extracts requests limit
        * info, and checks response code.
        */
        makeRequest = function (handler, paramsKeyValue, waitTime) {
          paramsKeyValue = paramsKeyValue || {};
          paramsKeyValue.callback = 'JSON_CALLBACK';
          if ($cookies.accessToken) {
            paramsKeyValue.access_token = $cookies.accessToken;
          }
          var url = endpoint + '/' + handler + '?' + convertToQueryString(paramsKeyValue);

          var dataReceived = $q.defer();
          $http.jsonp(url).then(function (res) {
            var rateLimit = extractRateLimit(res);
            $rootScope.$broadcast('github:rateLimitChanged', rateLimit);

            var status = res.data.meta && res.data.meta.status;
            var rateLimitExceeded = (status === 403 && rateLimit.remaining === 0);
            if (rateLimitExceeded) {
              // If we have exceeded our rate limit, lets enter into polling mode
              // before we can satisfy the promise. Polling interval starts from 10
              // seconds and increases twice every time, but is capped by 30 minutes
              waitTime = (waitTime || 5) * 2;
              waitTime = Math.min(waitTime, 30 * 60);

              $timeout(function (){
                makeRequest(handler, paramsKeyValue, waitTime).then(function (result) {
                  dataReceived.resolve(result);
                }, function (reason) {
                  dataReceived.reject(reason);
                });
              }, waitTime * 1000);
            } else if (status === 200) {
              dataReceived.resolve(res.data);
            } else {
              dataReceived.reject({
                statusCode: status,
                response: res.data
              });
            }
          }, function(reason) {
            dataReceived.reject(reason);
          });
          return dataReceived.promise;
        },

        shrinker = function(originalObj, requiredFields) {
          if (requiredFields) {
            var result = {};
            for (var key in requiredFields) {
              if (requiredFields.hasOwnProperty(key)) {
                result[key] = originalObj[key];
              }
            }
            return result;
          }
          return originalObj;
        },
        getRelPage = function (metaLink, rel) {
          if (!metaLink) {
            return; // nothing to do here.
          }
          for(var i = 0; i < metaLink.length; ++i) {
            var record = metaLink[i];
            var recordLink = record[0];
            var recordRel = record[1] && record[1].rel;
            if (recordRel === rel) {
              var count = recordLink.match(/\bpage=(\d+)/)[1];
              if (count) {
                return parseInt(count, 10);
              }
            }
          }
        },
        /**
        * Gets all pages from meta information of github request
        */
        getAllPages = function (handler, shrinkPattern) {
          var download = progressingPromise.defer();
          // forward declaration of functional expressions
          var downloadRemainingPages, getFirstPage;

          var result = [];
          var savePageResult = function (res) {
            var savedPageData = [];
            var shrinkedObj;
            for (var i = 0; i < res.data.length; ++i) {
              shrinkedObj = shrinker(res.data[i], shrinkPattern);
              savedPageData.push(shrinkedObj);
              result.push(shrinkedObj);
            }
            return savedPageData;
          };
          downloadRemainingPages = function(res) {
            var data = res && res.data;
            if (!angular.isArray(data)) {
              download.reject(data); // something goes wrong. Missing repository?
              return;
            }
            var metaLink = res.meta && res.meta.Link;
            var next = getRelPage(metaLink, 'next'),
                total = getRelPage(metaLink, 'last');
            var pageData = savePageResult(res);

            var stopNow = download.reportProgress({
              nextPage: next,
              totalPages: total,
              perPage: 100,
              data: pageData
            });
            if (stopNow) {
              download.reject('Record contains too many pages. Ignoring request.');
            } else if (next && total) {
              // client has approved download of all remaining pages. Let's schedule them all
              var remainingPageDownloadPromise = [];
              var remainedCount = total - next;
              var createPageDataSaver = function () {
                return function (res) {
                  var pageData = savePageResult(res);
                  remainedCount -= 1;
                  download.reportProgress({
                    nextPage: total - remainedCount,
                    totalPages: total,
                    perPage: 100,
                    data: pageData
                  });
                };
              };
              for (var i = next; i <= total; ++i) {
                remainingPageDownloadPromise.push(
                  makeRequest(handler, {
                    per_page: 100,
                    page: i
                  }).then(createPageDataSaver())
                );
              }
              $q.all(remainingPageDownloadPromise).then(
                function () {
                  download.resolve(result);
                },
                function (reason) {
                  download.reject(reason);
                }
              );
            } else {
              download.resolve(result);
            }
          };

          getFirstPage = function() {
            makeRequest(handler, {
                per_page: 100,
                page: 1
              }).then(downloadRemainingPages, function (err) {
                // if something goes wrong here, lets reject the entire process
                download.reject(err);
              });
          };

          // kick of pages download
          getFirstPage();

          return download.promise;
        };

    return {
      getUser: function () {
        return makeRequest('user').then(function (res) { return res.data; });
      },
      getStargazers: function(repoName, shrinkPattern) {
        // TODO: this function and getStarredProjects() below are very similar
        // in their cache control flow. Consider refactoring this.
        var download = progressingPromise.defer();
        // when we don't have a record for this repository - go to GitHub:
        var cacheMiss = function () {
          getAllPages('repos/' + repoName + '/stargazers', shrinkPattern)
            .progress(function (report) {
              return download.reportProgress(report);
            }).then(function (stargazers) {
              cacheService.saveProjectFollowers(repoName, stargazers);
              download.resolve(stargazers);
              return stargazers;
            }, function (err) {
              download.reject(err);
            });
        };
        var cacheHit = function (cache) {
          download.reportProgress({
            nextPage: 0,
            totalPages: 0,
            perPage: cache.followers.length,
            data: cache.followers
          });
          $timeout(function () {
            download.resolve(cache.followers);
          });
        };

        if (isCaching) {
          cacheService.getProjectFollowers(repoName).then(cacheHit, cacheMiss);
        } else {
          cacheMiss();
        }
        return download.promise;
      },

      getStarredProjects: function (userName, shrinkPattern) {
        var download = progressingPromise.defer();
        // go to GitHub when the record is not found in the cache:
        var cacheMiss = function () {
          getAllPages('users/' + userName + '/starred', shrinkPattern)
            .progress(function (report) {
              return download.reportProgress(report);
            }).then(function (starredProjects) {
              cacheService.saveStarredProjects(userName, starredProjects);
              download.resolve(starredProjects);
              return starredProjects;
            }, function (err) {
              download.reject(err);
            });
        };
        // otherwise pretend we are doing regular progress notification.
        var cacheHit = function (starredProjects) {
          download.reportProgress({
            nextPage: 0,
            totalPages: 0,
            perPage: starredProjects.length,
            data: starredProjects
          });
          $timeout(function () {
            download.resolve(starredProjects);
          });
        };

        if (isCaching) {
          cacheService.getStarredProjects(userName).then(cacheHit, cacheMiss);
        } else {
          // assume it's a miss:
          cacheMiss();
        }

        return download.promise;
      },

      cacheEnabled: function () {
        return isCaching;
      },
      cacheSupported: function () {
        return cacheService.isSupported;
      },
      setCaching: function (enabled) {
        $cookies.cacheEnabled = enabled.toString();
        isCaching = enabled;
      }
    };
  }]);
